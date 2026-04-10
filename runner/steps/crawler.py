import re
import json
import asyncio
import socket
import subprocess
import tempfile
from pathlib import Path
from datetime import datetime
from urllib.parse import urlencode

from playwright.async_api import async_playwright, Page, BrowserContext


def _free_port():
    with socket.socket() as s:
        s.bind(('', 0))
        return s.getsockname()[1]

try:
    from playwright_stealth import stealth_async
    HAS_STEALTH = True
except ImportError:
    HAS_STEALTH = False

DEFAULT_UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/124.0.0.0 Safari/537.36'
)

# Patches manuais básicos caso playwright-stealth não esteja instalado
STEALTH_SCRIPT = """
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    Object.defineProperty(navigator, 'permissions', {
        get: () => ({ query: (p) => Promise.resolve({ state: 'granted' }) })
    });
"""


class CrawlerStep:
    def __init__(self, spec: dict, params: dict, output_dir: Path, context: dict = None):
        self.spec = spec
        self.params = params
        self.output_dir = output_dir
        self.context = context if context is not None else {}

    # ── Template substitution ──────────────────────────────────────────────

    def substitute(self, value: str) -> str:
        if not isinstance(value, str):
            return value

        def replace(m):
            name = m.group(1)
            return str(self.params.get(name, m.group(0)))

        return re.sub(r'\{\{(\w+)\}\}', replace, value)

    def substitute_dict(self, d: dict) -> dict:
        return {k: self.substitute(v) for k, v in d.items()}

    def build_output_path(self) -> Path:
        template = self.spec.get('output_file', 'resultado_{{timestamp}}.pdf')
        name = self.substitute(template)
        name = name.replace('{{timestamp}}', datetime.now().strftime('%Y%m%d_%H%M%S'))
        name = re.sub(r'[<>:"/\\|?*]', '_', name)
        return self.output_dir / name

    # ── Main execution ─────────────────────────────────────────────────────

    async def execute(self):
        url         = self.spec['url']
        method      = self.spec.get('method', 'GET').upper()
        headers     = self.spec.get('headers', {})
        data        = self.substitute_dict(self.spec.get('data', {}))
        print_selector = self.spec.get('print_selector')

        headless    = self.spec.get('headless', False)
        use_stealth = self.spec.get('stealth', True)
        wait_until  = self.spec.get('wait_until', 'networkidle')
        timeout     = self.spec.get('timeout', 30_000)
        proxy_url   = self.spec.get('proxy')
        profile     = self.spec.get('profile')  # path p/ contexto persistente

        print(f'\n[step: {self.spec.get("name", "crawler")}]')
        print(f'  {method} {url}')
        if data:
            print(f'  params: {json.dumps(data, ensure_ascii=False)}')
        if proxy_url:
            print(f'  proxy: {proxy_url}')
        if profile:
            print(f'  perfil: {profile}')

        # ── Opções de contexto ─────────────────────────────────────────────
        context_opts = {
            'user_agent': DEFAULT_UA,
            'viewport': {'width': 1920, 'height': 1080},
            'locale': 'pt-BR',
            'timezone_id': 'America/Sao_Paulo',
        }

        SKIP = {'host', 'content-length', 'connection', 'transfer-encoding',
                'upgrade-insecure-requests', 'cookie'}
        if headers:
            safe = {k: v for k, v in headers.items()
                    if not k.startswith(':') and k.lower() not in SKIP}
            if safe:
                context_opts['extra_http_headers'] = safe

        async with async_playwright() as p:
            proc = None

            if not headless:
                # Lança Chromium como processo externo e conecta via CDP.
                # Ao desconectar, o browser fica aberto para o usuário ver.
                port = _free_port()
                tmp  = tempfile.mkdtemp()
                args = [
                    p.chromium.executable_path,
                    f'--remote-debugging-port={port}',
                    f'--user-data-dir={tmp}',
                    '--no-first-run', '--no-default-browser-check',
                ]
                if proxy_url:
                    args.append(f'--proxy-server={proxy_url}')
                proc = subprocess.Popen(args)
                await asyncio.sleep(1.5)  # aguarda o browser iniciar
                browser  = await p.chromium.connect_over_cdp(f'http://localhost:{port}')
                ctx_list = browser.contexts
                context  = ctx_list[0] if ctx_list else await browser.new_context(**context_opts)
            elif profile:
                profile_path = Path(profile).expanduser()
                profile_path.mkdir(parents=True, exist_ok=True)
                context = await p.chromium.launch_persistent_context(
                    str(profile_path), headless=True,
                    **(({'proxy': {'server': proxy_url}} if proxy_url else {})),
                    **context_opts,
                )
                browser = None
            else:
                launch_opts = {'headless': True}
                if proxy_url:
                    launch_opts['proxy'] = {'server': proxy_url}
                browser = await p.chromium.launch(**launch_opts)
                context = await browser.new_context(**context_opts)

            page = await context.new_page()

            if use_stealth:
                if HAS_STEALTH:
                    await stealth_async(page)
                else:
                    await page.add_init_script(STEALTH_SCRIPT)

            try:
                await self._navigate(page, method, url, data, wait_until, timeout)
                print(f'  página: {page.url}')

                await self._save_to_context(page)

                if print_selector:
                    await self._click_and_save_pdf(page, print_selector, timeout)
                elif self.spec.get('output_file'):
                    await self._save_pdf(page)

            finally:
                if not headless:
                    # Só desconecta — o browser fica aberto para o usuário
                    try: await browser.close()
                    except Exception: pass
                    print('  browser aberto para visualização (feche quando quiser)')
                elif browser:
                    try: await browser.close()
                    except Exception: pass
                else:
                    try: await context.close()
                    except Exception: pass

    # ── Context ────────────────────────────────────────────────────────────

    async def _save_to_context(self, page: Page):
        html = await page.content()
        self.context['last_html'] = html
        self.context['last_url'] = page.url
        self.context.pop('last_json', None)

        # Tenta detectar se a resposta é JSON puro
        stripped = html.strip()
        if stripped.startswith('{') or stripped.startswith('['):
            try:
                import json as _json
                from bs4 import BeautifulSoup
                soup = BeautifulSoup(html, 'html.parser')
                body = soup.find('body')
                text = body.get_text() if body else stripped
                self.context['last_json'] = _json.loads(text)
                print('  conteúdo: JSON detectado')
            except Exception:
                pass

        # Salva em arquivo se configurado
        save_content = self.spec.get('save_content')
        if save_content:
            name = re.sub(r'[<>:"/\\|?*]', '_', self.substitute(save_content))
            # Garante extensão correta
            if self.context.get('last_json') is not None and not name.endswith('.json'):
                name = name + '.json'
            elif not name.endswith('.html') and not name.endswith('.json'):
                name = name + '.html'

            output = self.output_dir / name
            if name.endswith('.json'):
                import json as _json
                output.write_text(
                    _json.dumps(self.context['last_json'], ensure_ascii=False, indent=2),
                    encoding='utf-8'
                )
            else:
                output.write_text(html, encoding='utf-8')
            print(f'  conteúdo salvo → {output}')

    # ── Navigation ─────────────────────────────────────────────────────────

    async def _navigate(self, page: Page, method: str, url: str, data: dict,
                        wait_until: str, timeout: int):
        if method == 'GET':
            full_url = (url + '?' + urlencode(data)) if data else url
            print(f'  navegando → {full_url}')
            await page.goto(full_url, wait_until=wait_until, timeout=timeout)

        elif method == 'POST':
            print(f'  enviando POST → {url}')
            await page.goto('about:blank')
            await page.evaluate(
                """([url, data]) => {
                    const form = document.createElement('form');
                    form.method = 'POST';
                    form.action = url;
                    for (const [k, v] of Object.entries(data)) {
                        const inp = document.createElement('input');
                        inp.type  = 'hidden';
                        inp.name  = k;
                        inp.value = v;
                        form.appendChild(inp);
                    }
                    document.body.appendChild(form);
                    form.submit();
                }""",
                [url, data],
            )
            await page.wait_for_load_state(wait_until, timeout=timeout)

        else:
            raise ValueError(f'Método HTTP não suportado: {method}')

    # ── PDF helpers ────────────────────────────────────────────────────────

    async def _save_pdf(self, page: Page):
        output = self.build_output_path()
        await page.pdf(path=str(output), format='A4', print_background=True)
        print(f'  PDF salvo → {output}')

    async def _click_and_save_pdf(self, page: Page, selector: str, timeout: int):
        print(f'  aguardando botão: {selector}')
        try:
            await page.wait_for_selector(selector, timeout=timeout)
        except Exception:
            print(f'  botão não encontrado ({selector}), salvando página atual...')
            await self._save_pdf(page)
            return

        print(f'  clicando em: {selector}')

        try:
            async with page.context.expect_page(timeout=5_000) as new_page_info:
                await page.click(selector)
            new_page = await new_page_info.value
            await new_page.wait_for_load_state('networkidle', timeout=timeout)
            output = self.build_output_path()
            await new_page.pdf(path=str(output), format='A4', print_background=True)
            print(f'  PDF salvo → {output}')

        except Exception:
            print('  nova aba não aberta, salvando página atual...')
            await self._save_pdf(page)
