import json
import re
from pathlib import Path
from datetime import datetime

from bs4 import BeautifulSoup


class ParserStep:
    def __init__(self, spec: dict, params: dict, output_dir: Path, context: dict):
        self.spec = spec
        self.params = params
        self.output_dir = output_dir
        self.context = context

    # ── Template substitution ──────────────────────────────────────────────

    def substitute(self, value: str) -> str:
        if not isinstance(value, str):
            return value

        def replace(m):
            name = m.group(1)
            return str(self.params.get(name, m.group(0)))

        return re.sub(r'\{\{(\w+)\}\}', replace, value)

    # ── Main execution ─────────────────────────────────────────────────────

    async def execute(self):
        step_name = self.spec.get('name', 'parser')
        print(f'\n[step: {step_name}]')

        # Verifica condição — se variável não foi resolvida, pula o step
        condition = self.spec.get('condition')
        if condition:
            resolved = self.substitute(condition)
            if re.search(r'\{\{\w+\}\}', resolved) or not resolved:
                print('  condition não satisfeita, pulando')
                return

        fields = self.spec.get('fields', [])
        last_json = self.context.get('last_json')
        last_html = self.context.get('last_html', '')

        if last_json is not None:
            print('  modo: JSON')
            result = self._parse_json_fields(last_json, fields)
        elif last_html:
            print('  modo: HTML/CSS')
            soup = BeautifulSoup(last_html, 'html.parser')
            result = self._parse_html_fields(soup, fields)
        else:
            print('  nenhum conteúdo disponível para parsear')
            return

        # Log resumido
        preview = json.dumps(result, ensure_ascii=False, default=str)
        print(f'  extraído: {preview[:300]}{"..." if len(preview) > 300 else ""}')

        # Valores simples (str/int/float) entram nos params para steps seguintes
        if isinstance(result, dict):
            self.params.update({
                k: v for k, v in result.items()
                if isinstance(v, (str, int, float))
            })

        self.context['last_result'] = result

        # Salva em arquivo se configurado
        output_file = self.spec.get('output_file')
        if output_file:
            name = re.sub(r'[<>:"/\\|?*]', '_', self.substitute(output_file))
            output = self.output_dir / name
            output.write_text(
                json.dumps(result, ensure_ascii=False, indent=2, default=str),
                encoding='utf-8'
            )
            print(f'  resultado salvo → {output}')

    # ── JSON parsing ───────────────────────────────────────────────────────

    def _parse_json_fields(self, data, fields: list) -> dict:
        result = {}
        for field in fields:
            value = self._extract_json_field(data, field)
            if field.get('omit_name') and isinstance(value, dict):
                result.update(value)
            else:
                result[field['name']] = value
        return result

    def _extract_json_field(self, data, field: dict):
        field_type = field.get('type', 'TextField')
        path = field.get('json_path', '')
        value = self._json_get(data, path) if path else data

        if field_type == 'ListField':
            if not isinstance(value, list):
                value = [value] if value is not None else []
            child = field.get('field', {})
            return [self._extract_json_field(item, child) for item in value]

        if field_type == 'DictField':
            return self._parse_json_fields(value or {}, field.get('fields', []))

        # TextField / DateTimeField
        text = str(value) if value is not None else ''
        text = self._apply_regex(text, field)

        if field_type == 'DateTimeField' and text:
            return self._parse_date(text)

        return text

    def _json_get(self, data, path: str):
        """
        Resolve caminhos como "data.[*]", "dataJulgamento", "nested.field".
        [*] indica que o resultado deve ser lista.
        """
        is_list = '[*]' in path
        clean = path.replace('.[*]', '').replace('[*]', '').strip('.')
        parts = [p for p in clean.split('.') if p]

        result = data
        for part in parts:
            if result is None:
                return None
            if isinstance(result, dict):
                result = result.get(part)
            elif isinstance(result, list):
                result = [item.get(part) for item in result if isinstance(item, dict)]

        if is_list and not isinstance(result, list):
            return [result] if result is not None else []

        return result

    # ── HTML / CSS parsing ─────────────────────────────────────────────────

    def _parse_html_fields(self, element, fields: list) -> dict:
        result = {}
        for field in fields:
            value = self._extract_html_field(element, field)
            if field.get('omit_name') and isinstance(value, dict):
                result.update(value)
            else:
                result[field['name']] = value
        return result

    def _extract_html_field(self, element, field: dict):
        field_type = field.get('type', 'TextField')
        selector = field.get('css_selector', '')
        attribute = field.get('attribute')

        if field_type == 'ListField':
            elements = element.select(selector) if selector else [element]
            child = field.get('field', {})
            return [self._extract_html_field(el, child) for el in elements]

        if field_type == 'DictField':
            el = element.select_one(selector) if selector else element
            if el is None:
                return {}
            return self._parse_html_fields(el, field.get('fields', []))

        # TextField / DateTimeField
        el = element.select_one(selector) if selector else element
        if el is None:
            return None

        if attribute == 'innerHTML':
            text = el.decode_contents()
        elif attribute:
            text = el.get(attribute, '') or ''
        else:
            text = el.get_text(strip=True)

        text = self._apply_regex(str(text), field)

        if field_type == 'DateTimeField' and text:
            return self._parse_date(text)

        return text

    # ── Helpers ────────────────────────────────────────────────────────────

    def _apply_regex(self, text: str, field: dict) -> str:
        pattern = field.get('regex')
        if not pattern or not text:
            return text

        flags = 0
        if field.get('regex_insensitive'):
            flags |= re.IGNORECASE
        if field.get('regex_match_newline'):
            flags |= re.DOTALL

        try:
            matches = re.findall(pattern, text, flags)
            if not matches:
                return ''

            if field.get('regex_merge'):
                return ''.join(
                    m[0] if isinstance(m, tuple) else str(m) for m in matches
                )

            m = matches[0]
            return m[0] if isinstance(m, tuple) else str(m)

        except re.error as e:
            print(f'  regex inválido ({pattern}): {e}')
            return text

    def _parse_date(self, text: str) -> str:
        for fmt in ('%Y-%m-%dT%H:%M:%S', '%Y-%m-%dT%H:%M:%S.%f',
                    '%Y-%m-%d', '%d/%m/%Y %H:%M:%S', '%d/%m/%Y'):
            try:
                return datetime.strptime(text.strip(), fmt).isoformat()
            except ValueError:
                continue
        return text
