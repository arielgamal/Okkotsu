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
        # Contexto compartilhado entre steps (HTML, JSON, resultados)
        self.context: dict = {}

    async def run(self):
        # Suporta pipeline { "steps": [...] } e spec legada (step único)
        if 'steps' in self.spec:
            steps = self.spec['steps']
            print(f'Pipeline "{self.spec.get("name", "pipeline")}" — {len(steps)} step(s)\n')
        else:
            steps = [self.spec]

        for i, step_spec in enumerate(steps):
            name = step_spec.get('name', f'step_{i}')

            if not step_spec.get('activated', True):
                print(f'[step {i}: {name}] pulado (activated=false)\n')
                continue

            step_type = step_spec.get('type')
            StepClass = STEP_REGISTRY.get(step_type)

            if not StepClass:
                print(f'[step {i}: {name}] tipo desconhecido: "{step_type}" — pulando\n')
                continue

            step = StepClass(step_spec, self.params, self.output_dir, self.context)
            await step.execute()
