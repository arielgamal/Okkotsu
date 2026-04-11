import json
import re
from pathlib import Path
from steps.crawler import CrawlerStep
from steps.parser import ParserStep

# Registre novos tipos de step aqui
STEP_REGISTRY = {
    'crawler': CrawlerStep,
    'parser':  ParserStep,
}


class Runner:
    def __init__(self, spec: dict, params: dict, output_dir: Path):
        self.spec = spec
        self.params = params
        self.output_dir = output_dir
        self.context: dict = {}

    async def run(self):
        steps = self.spec.get('steps', [self.spec])
        print(f'Pipeline "{self.spec.get("name", "pipeline")}" — {len(steps)} step(s)\n')

        i = 0
        while i < len(steps):
            step_spec = steps[i]
            name = step_spec.get('name', f'step_{i}')

            if not step_spec.get('activated', True):
                print(f'[step {i}: {name}] pulado (activated=false)\n')
                i += 1
                continue

            # Step com paginação: consome este step + o próximo (parser) no loop
            if step_spec.get('pagination') and i + 1 < len(steps):
                next_spec = steps[i + 1]
                if next_spec.get('activated', True):
                    await self._run_paginated(step_spec, next_spec)
                    i += 2
                    continue

            await self._run_step(step_spec)
            i += 1

    # ── Step simples ───────────────────────────────────────────────────────

    async def _run_step(self, step_spec: dict):
        step_type = step_spec.get('type')
        StepClass = STEP_REGISTRY.get(step_type)
        if not StepClass:
            print(f'[step: {step_spec.get("name")}] tipo desconhecido: "{step_type}" — pulando\n')
            return
        step = StepClass(step_spec, self.params, self.output_dir, self.context)
        await step.execute()

    # ── Loop de paginação ──────────────────────────────────────────────────

    async def _run_paginated(self, crawler_spec: dict, parser_spec: dict):
        pagination     = crawler_spec['pagination']
        kind           = pagination.get('kind', 'offset')  # 'page' ou 'offset'
        param          = pagination['param']
        items_per_page = int(pagination['items_per_page'])
        offset         = int(pagination.get('start', 1 if kind == 'page' else 0))
        step_size      = 1 if kind == 'page' else items_per_page
        total_var      = pagination.get('total_var')

        all_items = []
        page = 1

        # Parseia a página já carregada no contexto (página anterior ao loop)
        if self.context.get('last_html') or self.context.get('last_json'):
            print(f'\n══ Página 1 (contexto anterior) ══')
            parser = ParserStep(parser_spec, self.params, self.output_dir, self.context)
            await parser.execute()
            result = self.context.get('last_result', {})
            page_items = self._extract_list(result)
            all_items.extend(page_items)
            print(f'  página 1: {len(page_items)} item(s) | acumulado: {len(all_items)}')
            page = 2

        while True:
            print(f'\n══ Página {page} ({param}={offset}) ══')
            self.params[param] = str(offset)

            # Executa crawler
            crawler = CrawlerStep(crawler_spec, self.params, self.output_dir, self.context)
            await crawler.execute()

            # Executa parser
            parser = ParserStep(parser_spec, self.params, self.output_dir, self.context)
            await parser.execute()

            # Coleta itens desta página
            result     = self.context.get('last_result', {})
            page_items = self._extract_list(result)
            all_items.extend(page_items)

            print(f'  página {page}: {len(page_items)} item(s) | acumulado: {len(all_items)}')

            offset += step_size
            page   += 1

            # Parada por total conhecido
            if total_var:
                try:
                    total = int(str(self.params.get(total_var, '')).strip())
                    if offset >= total:
                        print(f'\n  paginação concluída ({len(all_items)} de {total} itens)')
                        break
                except (ValueError, TypeError):
                    pass  # total ainda não disponível — usa fallback abaixo

            # Parada por página incompleta (última página)
            if len(page_items) < items_per_page:
                print(f'\n  última página detectada ({len(page_items)} < {items_per_page} itens)')
                break

        # Salva resultado completo sobrescrevendo o arquivo do parser
        step_name = re.sub(r'[<>:"/\\|?*]', '_', parser_spec.get('name', 'resultado'))
        output = self.output_dir / f'{step_name}.json'
        output.write_text(
            json.dumps(all_items, ensure_ascii=False, indent=2, default=str),
            encoding='utf-8'
        )
        print(f'\n  resultado completo salvo → {output} ({len(all_items)} itens)')

    @staticmethod
    def _extract_list(result: dict) -> list:
        """Extrai a lista de itens do resultado do parser."""
        if isinstance(result, list):
            return result
        for v in result.values():
            if isinstance(v, list):
                return v
        return [result] if result else []
