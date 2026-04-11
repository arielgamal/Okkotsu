# Okkotsu — Robô de Automação baseado em Spec JSON

Um robô que recebe uma spec em formato JSON contendo uma pipeline de steps.
O runner executa os steps em ordem. A arquitetura é genérica e funciona com qualquer site.

---

## Estrutura do projeto

```
Okkotsu/
├── extension/          ← Extensão Chrome para montar a pipeline visualmente
│   ├── manifest.json
│   ├── background.js   ← Service worker: debugger, picker, download
│   ├── sidepanel.html  ← Shell HTML do painel lateral
│   ├── sidepanel.js    ← Toda a lógica de UI (~900 linhas)
│   └── sidepanel.css   ← Tema escuro
├── runner/             ← Runner Python que executa a pipeline
│   ├── main.py         ← Entrada CLI
│   ├── runner.py       ← Orquestra steps, mantém contexto compartilhado
│   └── steps/
│       ├── crawler.py  ← Step tipo "crawler" (navegação Playwright)
│       └── parser.py   ← Step tipo "parser" (extração de dados)
├── specs/              ← Arquivos de pipeline JSON
├── results/            ← JSONs e PDFs gerados pelo runner
└── params.json         ← Valores das variáveis em tempo de execução
```

---

## Extensão Chrome (Okkotsu)

A extensão usa o **Side Panel** do Chrome (não o DevTools). O painel fica sempre visível
na lateral do browser, sem desaparecer durante navegação.

### Interface

O painel é centrado na **pipeline**. Os steps se formam inline, um abaixo do outro.

- **Header**: campo para nome da pipeline + botão `⬇ JSON` (exportar spec)
- **Step cards**: cada step adicionado aparece como cartão expansível com badge de tipo,
  nome, resumo, chevron e botão `×` para remover
- **+ Adicionar step**: abre seletor de tipo inline → formulário de configuração → confirma

### Tipos de step

| Tipo | Badge | Descrição |
|---|---|---|
| `crawler` | 📡 crawler | Grava e usa uma requisição HTTP |
| `parser` | ⬡ parser | Extrai valores do HTML ou JSON |
| `lista` | ☰ lista | Extrai uma lista de itens com seletor CSS de container |

### Como usar (Crawler)

1. Carregar `extension/` em `chrome://extensions` (modo desenvolvedor)
2. Clicar no ícone da extensão → painel lateral abre
3. Clicar **+ Adicionar step** → **Requisição**
4. Clicar **⏺ Gravar** → navegar e usar o site → **⏹ Parar**
5. Clicar na requisição desejada → tela de configuração:
   - Dar nome ao step
   - Marcar parâmetros que devem ser variáveis `{{nome}}`
   - Definir nome de arquivo para salvar conteúdo (opcional)
6. Clicar **+ Adicionar Step** → step aparece na pipeline
7. Repetir para cada step, depois exportar o JSON

### Como usar (Parser / Lista)

1. Clicar **+ Adicionar step** → **Parser** ou **Lista**
2. Dar nome ao step
3. **Lista**: definir o seletor CSS do container de cada item (botão `⊕ Pick` para clicar na página)
4. Clicar **+ Campo** para cada campo a extrair:
   - **Nome**: nome do campo no resultado JSON
   - **Tipo**: `Text`, `DateTime`, `Number`
   - **Modo**: `CSS` (seletor na página) | `JSON` (json_path) | `Calc.` (expressão Python)
   - **Seletor**: digitar ou usar `⊕ Pick` para clicar no elemento da página
   - **Atributo**: opcional (`href`, `innerHTML`, etc.)
   - **Regex**: opcional para filtrar o texto extraído
   - Botão **Testar**: valida o seletor contra a aba ativa e mostra preview
5. Clicar **+ Adicionar Step**

### Picker (`⊕ Pick`)

Injeta um script na aba ativa que destaca elementos ao passar o mouse.
Ao clicar num elemento, retorna o seletor CSS automaticamente.
`Esc` cancela. Pode ser usado várias vezes — substitui o campo anterior.

---

## Formato da Pipeline (spec JSON)

```json
{
  "name": "busca_dou",
  "version": "1.0",
  "steps": [
    {
      "type": "crawler",
      "name": "step_0",
      "activated": true,
      "url": "https://www.in.gov.br/consulta/-/buscar/dou",
      "method": "GET",
      "headers": { "...": "..." },
      "contentType": "query",
      "statusCode": 200,
      "data": {
        "q": "{{termo}}",
        "publishFrom": "{{data_inicio}}",
        "publishTo": "{{data_fim}}"
      },
      "samples": {
        "q": "*",
        "publishFrom": "09/04/2026",
        "publishTo": "09/04/2026"
      }
    },
    {
      "type": "parser",
      "name": "parser_1",
      "activated": true,
      "fields": [
        { "name": "total",  "type": "TextField", "mode": "css", "css_selector": "p.search-total-label" },
        { "name": "titulo", "type": "TextField", "mode": "json", "json_path": "data.[*].titulo" },
        { "name": "resumo", "type": "TextField", "mode": "computed", "value": "{{titulo.strip()[:100]}}" }
      ]
    }
  ]
}
```

### Campos do step `crawler`

| Campo | Padrão | Descrição |
|---|---|---|
| `type` | obrigatório | `"crawler"` |
| `name` | obrigatório | Nome identificador do step |
| `url` | obrigatório | URL da requisição (suporta `{{variavel}}`) |
| `method` | `"GET"` | `GET` ou `POST` |
| `headers` | — | Headers HTTP capturados |
| `data` | — | Parâmetros query/body (suporta `{{variavel}}`) |
| `samples` | — | Valores de exemplo capturados (referência, não usado pelo runner) |
| `contentType` | — | Metadado informativo (`query`, `form`, `json`, `raw`) |
| `statusCode` | — | Metadado informativo do status HTTP capturado |
| `activated` | `true` | Se `false`, o step é pulado |
| `save_content` | — | Salva HTML ou JSON da página em `results/` (ex: `"pagina_{{data}}"`) — extensão adicionada automaticamente |
| `output_file` | — | Nome do PDF de saída (suporta `{{variavel}}`) |
| `print_selector` | — | CSS selector do botão imprimir — clica e salva PDF da nova aba |
| `headless` | `false` | Se `true`, roda sem abrir janela do browser |
| `stealth` | `true` | Patches anti-detecção (navigator.webdriver, plugins, etc.) |
| `wait_until` | `"networkidle"` | Quando considerar a página carregada: `load`, `networkidle`, `domcontentloaded` |
| `timeout` | `30000` | Timeout em ms |
| `proxy` | — | Proxy HTTP/HTTPS: `"http://usuario:senha@host:porta"` |
| `profile` | — | Caminho para perfil persistente do browser (mantém cookies/login) |
| `pagination` | — | Ativa loop de paginação automático (ver abaixo) |

### Paginação automática (`pagination`)

Quando um crawler tem o bloco `pagination`, o runner entra em loop automático com o step seguinte (que deve ser um parser de lista). A página já carregada antes do loop também é parseada automaticamente.

| Campo | Descrição |
|---|---|
| `kind` | `"page"` (newPage=1,2,3) ou `"offset"` (start=0,20,40) |
| `param` | Nome do parâmetro que muda entre páginas (ex: `"newPage"`, `"start"`) |
| `start` | Valor inicial do parâmetro (padrão: `2` para page, `0` para offset) |
| `items_per_page` | Quantos itens cabem numa página cheia — detecta a última página |
| `total_var` | Opcional — variável com total de documentos extraída por um parser anterior |

O parâmetro definido em `param` deve estar no `data` do crawler com `{{param}}` para ser substituído a cada iteração.

Parada automática:
- Se `total_var` definido: para quando todas as páginas foram cobertas
- Sempre: para quando a página retorna menos itens que `items_per_page` (última página)

```json
"data": { "newPage": "{{newPage}}", "delta": "20", ... },
"pagination": {
  "kind": "page",
  "param": "newPage",
  "start": 2,
  "items_per_page": 20,
  "total_var": "total_docs"
}
```

### Campos do step `parser`

| Campo | Padrão | Descrição |
|---|---|---|
| `type` | obrigatório | `"parser"` |
| `name` | obrigatório | Nome identificador — também define o nome do arquivo de saída (`{name}.json`) |
| `activated` | `true` | Se `false`, o step é pulado |
| `condition` | — | Expressão `{{variavel}}` — se não resolvida, o step é pulado |
| `fields` | obrigatório | Lista de campos a extrair |
| `output_file` | — | Reservado (não usado atualmente — saída sempre é `{name}.json`) |

### Propriedades de campo (`fields`)

| Propriedade | Descrição |
|---|---|
| `name` | Nome do campo no resultado JSON |
| `type` | `TextField`, `DateTimeField`, `NumberField`, `ListField`, `DictField` |
| `mode` | `"css"` (seletor HTML), `"json"` (json_path), `"computed"` (expressão Python) |
| `css_selector` | Seletor CSS do elemento — modo `css` |
| `attribute` | Atributo HTML a extrair: `href`, `innerHTML`, etc. Padrão: texto visível |
| `json_path` | Caminho no JSON: `"data.[*]"`, `"nested.field"` — modo `json` |
| `value` | Expressão Python com `{{campo}}` — modo `computed` |
| `regex` | Regex para filtrar o valor extraído |
| `regex_insensitive` | `true` para case-insensitive |
| `regex_match_newline` | `true` para `.` casar quebras de linha |
| `regex_merge` | `true` para concatenar todos os matches |
| `emit_event` | Nome do evento emitido para o contexto (ex: `"TOTAL_DOCUMENTOS"`) |
| `required` | Metadado informativo (não impede execução) |
| `sample` | Valor de exemplo (referência) |
| `omit_name` | `true` para não aninhar sob o nome do campo (útil em `DictField`) |

### Exemplo — lista via CSS (gerado pelo tipo "Lista" na extensão)

```json
{
  "type": "parser",
  "name": "lista_resultados",
  "fields": [
    {
      "name": "itens",
      "type": "ListField",
      "css_selector": ".resultado-item",
      "omit_name": true,
      "field": {
        "type": "DictField",
        "fields": [
          { "name": "titulo", "type": "TextField", "mode": "css", "css_selector": "h5.title-marker > a" },
          { "name": "link",   "type": "TextField", "mode": "css", "css_selector": "a", "attribute": "href" },
          { "name": "data",   "type": "DateTimeField", "mode": "css", "css_selector": "span.date" }
        ]
      }
    }
  ]
}
```

### Exemplo — extração JSON

```json
{
  "type": "parser",
  "name": "extrai_json",
  "fields": [
    {
      "name": "itens",
      "type": "ListField",
      "json_path": "data.[*]",
      "omit_name": true,
      "field": {
        "type": "DictField",
        "fields": [
          { "name": "titulo",  "type": "TextField",    "mode": "json", "json_path": "titulo" },
          { "name": "data",    "type": "DateTimeField", "mode": "json", "json_path": "dataPublicacao" },
          { "name": "numero",  "type": "TextField",    "mode": "json", "json_path": "numeroProcesso" }
        ]
      }
    }
  ]
}
```

---

## Variáveis (`{{variavel}}`)

Campos com `{{variavel}}` são substituídos pelos valores de `params.json` antes de executar o step.
Valores extraídos por steps `parser` também ficam disponíveis como variáveis para steps seguintes.

Campos `computed` suportam expressões Python completas: `{{titulo.strip()[:100]}}`.

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

Executa a pipeline em ordem (step 0, 1, 2...). Steps com `activated: false` são pulados.
O runner mantém um **contexto compartilhado** (`dict`) passado para todos os steps.

### Instalar

```bash
cd runner
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
```

### Rodar

```bash
python main.py ../specs/pipeline.json
python main.py ../specs/pipeline.json --params ../params.json --output-dir ../results
```

### Contexto compartilhado entre steps

| Chave | Definido por | Descrição |
|---|---|---|
| `last_html` | `crawler` | HTML completo da última página carregada |
| `last_json` | `crawler` | JSON parsed (se resposta detectada como JSON) |
| `last_url` | `crawler` | URL final após navegação |
| `last_result` | `parser` | Dicionário com o último resultado extraído |
| `events` | `parser` | Lista de eventos emitidos via `emit_event` |

### Comportamento do crawler

- Por padrão abre uma janela visível do browser (não headless)
- O browser é lançado como processo externo via CDP — ao terminar o step, o Playwright
  desconecta mas **o browser permanece aberto** para o usuário inspecionar
- O HTML (ou JSON) da página é sempre salvo no contexto, independente de `save_content`
- `save_content` salva adicionalmente em arquivo no `output_dir`
- Após navegar, aguarda o DOM estabilizar (compara tamanho do HTML a cada 500ms até parar de crescer, máx 10s) antes de capturar — garante que conteúdo renderizado por JavaScript seja capturado
- O runner não espera nenhuma interação do usuário — continua para o próximo step

### Comportamento do parser

- Detecta automaticamente se o conteúdo do contexto é JSON ou HTML
- Processa campos em ordem — cada campo extraído fica disponível para campos seguintes (inclusive campos `computed`)
- Sempre salva o resultado em `{output_dir}/{step_name}.json`
- Valores simples (string/número) são promovidos a variáveis `{{nome}}` para steps seguintes

### Registrar novo tipo de step

Em `runner/runner.py`, adicionar ao dicionário:

```python
STEP_REGISTRY = {
    'crawler': CrawlerStep,
    'parser':  ParserStep,
    'meu_tipo': MeuStep,   # ← novo tipo
}
```

---

## Próximos steps a implementar

- Iterar sobre a lista de resultados e entrar em cada link (loop sobre `ListField`)
- Clicar em "Imprimir" em cada publicação e salvar PDF individual
