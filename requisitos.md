# Robô de Automação baseado em Spec JSON

Um robô que recebe uma spec em formato JSON contendo uma pipeline de steps.
Cada step executa uma ação e pode ser de qualquer tipo. O runner executa os steps
em ordem, começando do step 0. A arquitetura é genérica e funciona com qualquer site.

---

## Arquitetura do projeto

```
robo/
├── extension/          ← Extensão Chrome para gravar e montar a pipeline
├── runner/             ← Runner Python que executa a pipeline
│   ├── main.py
│   ├── runner.py       ← Lê os steps e despacha para o tipo correto
│   └── steps/
│       └── crawler.py  ← Implementação do tipo "crawler"
├── specs/              ← Arquivos de pipeline JSON
├── results/            ← PDFs e resultados gerados
└── params.json         ← Valores das variáveis
```

---

## Extensão Chrome (Spec Recorder)

Painel dentro do DevTools (F12 → aba "Spec Recorder") com 3 colunas:

**Coluna 1 — Requisições capturadas**
- Botão ⏺ Gravar / ⏹ Parar
- Lista todas as requisições HTTP feitas durante a gravação
- Botão × para deletar qualquer requisição da lista
- Filtro por URL

**Coluna 2 — Configuração do step**
- Ao clicar numa requisição, exibe seus detalhes
- Permite dar um nome ao step
- Para cada campo da requisição: marcar como variável `{{nome}}`
- Seletor CSS do botão "Imprimir" (opcional)
- Nome do arquivo de saída (opcional)
- Botão **+ Adicionar como Step N** → adiciona ao painel de steps

**Coluna 3 — Steps da pipeline**
- Lista os steps adicionados em ordem (0, 1, 2...)
- Botão × para remover qualquer step
- Campo para nome da pipeline
- Botão **⬇ Exportar Pipeline** → gera o JSON final

**Como usar:**
1. Carregar `extension/` em `chrome://extensions` (modo desenvolvedor)
2. Abrir F12 → aba "Spec Recorder"
3. Clicar ⏺ Gravar → navegar e usar o site normalmente → ⏹ Parar
4. Selecionar a requisição desejada, configurar variáveis e nome
5. Clicar "+ Adicionar como Step" → repetir para cada step
6. Dar nome à pipeline e clicar "⬇ Exportar Pipeline"

---

## Formato da Pipeline (spec JSON)

```json
{
  "name": "busca_dou",
  "version": "1.0",
  "steps": [
    {
      "type": "crawler",
      "name": "busca_resultados",
      "url": "https://www.in.gov.br/consulta/-/buscar/dou",
      "method": "GET",
      "headers": { "...": "..." },
      "statusCode": 200,
      "contentType": "query",
      "data": {
        "q": "{{termo}}",
        "publishFrom": "{{data_inicio}}",
        "publishTo": "{{data_fim}}",
        "orgPrin": "{{orgao}}"
      },
      "samples": {
        "q": "*",
        "publishFrom": "09/04/2026",
        "publishTo": "09/04/2026",
        "orgPrin": "Ministério de Minas e Energia"
      },
      "id": "req_abc123",
      "activated": true
    },
    {
      "type": "crawler",
      "name": "salvar_pdf",
      "url": "...",
      "print_selector": ".btn-imprimir",
      "output_file": "resultado_{{termo}}_{{data_inicio}}.pdf",
      "activated": true
    }
  ]
}
```

### Campos do step `crawler`

| Campo | Padrão | Descrição |
|---|---|---|
| `type` | ✓ obrigatório | Tipo do step (`crawler`) |
| `name` | ✓ obrigatório | Nome identificador do step |
| `url` | ✓ obrigatório | URL da requisição |
| `method` | `"GET"` | `GET` ou `POST` |
| `headers` | — | Headers HTTP capturados |
| `data` | — | Parâmetros (suporta `{{variavel}}`) |
| `samples` | — | Valores de exemplo capturados (referência) |
| `activated` | `true` | Se `false`, o step é pulado |
| `output_file` | — | Nome do PDF de saída (suporta `{{variavel}}`) |
| `print_selector` | — | CSS selector do botão imprimir |
| `stealth` | `true` | Patches anti-detecção de bot (navigator.webdriver, plugins, etc.) |
| `headless` | `false` | Rodar sem abrir janela do browser |
| `wait_until` | `"load"` | Quando considerar a página carregada: `load`, `networkidle`, `domcontentloaded` |
| `timeout` | `30000` | Timeout em ms para navegação e seletores |
| `proxy` | — | Proxy HTTP/HTTPS: `"http://usuario:senha@host:porta"` |
| `profile` | — | Caminho para perfil persistente do browser (salva cookies e login entre execuções) |

### Variáveis (`{{variavel}}`)

Campos marcados com `{{variavel}}` são substituídos pelos valores de `params.json`
antes de executar o step.

---

## params.json

```json
{
  "termo": "licitação",
  "data_inicio": "01/04/2026",
  "data_fim": "09/04/2026",
  "orgao": "Ministério de Minas e Energia"
}
```

---

## Runner Python

Executa a pipeline em ordem (step 0, 1, 2...), abrindo um browser real (Playwright).
Steps com `activated: false` são pulados. Novos tipos de step podem ser registrados
em `runner.py` no dicionário `STEP_REGISTRY`.

**Instalar:**
```bash
cd runner
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
```

**Rodar:**
```bash
python main.py ../specs/pipeline.json
python main.py ../specs/pipeline.json --params ../params.json --output-dir ../results
```

### Comportamento do step `crawler`

| Configuração | Resultado |
|---|---|
| Sem `output_file` e sem `print_selector` | Abre o browser, carrega a página, aguarda Enter |
| Com `output_file` | Carrega a página, salva como PDF, aguarda Enter |
| Com `print_selector` | Clica no botão imprimir, salva PDF da nova aba, aguarda Enter |

---

## Site alvo: Diário Oficial da União

- URL: `https://www.in.gov.br/consulta/-/buscar`
- Método: GET com query params
- Sem captcha
- Filtros: termo, data, órgão, seção
- Resultado: lista de publicações com link para cada uma
- Cada publicação tem botão "Imprimir" → abre versão para impressão em nova aba

---

## Próximos steps a implementar

- Step para percorrer a lista de resultados e entrar em cada link
- Step para clicar em "Imprimir" e salvar PDF de cada publicação
- Outros tipos de step além do `crawler`
