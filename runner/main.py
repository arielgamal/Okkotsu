import argparse
import asyncio
import json
import sys
from pathlib import Path

from runner import Runner


def main():
    parser = argparse.ArgumentParser(description='Robô de automação baseado em spec JSON')
    parser.add_argument('spec', help='Caminho para o arquivo spec JSON')
    parser.add_argument('--params', default='../params.json', help='Arquivo de parâmetros (padrão: ../params.json)')
    parser.add_argument('--output-dir', default='../results', help='Diretório de saída para PDFs (padrão: ../results)')
    args = parser.parse_args()

    spec_path = Path(args.spec)
    params_path = Path(args.params)
    output_dir = Path(args.output_dir)

    if not spec_path.exists():
        print(f'Erro: spec não encontrada: {spec_path}')
        sys.exit(1)

    spec = json.loads(spec_path.read_text(encoding='utf-8'))

    params = {}
    if params_path.exists():
        params = json.loads(params_path.read_text(encoding='utf-8'))
        print(f'Parâmetros carregados de {params_path}')
    else:
        print(f'Aviso: {params_path} não encontrado — usando valores da spec (samples)')
        params = spec.get('samples', {})

    output_dir.mkdir(parents=True, exist_ok=True)

    runner = Runner(spec, params, output_dir)
    asyncio.run(runner.run())


if __name__ == '__main__':
    main()
