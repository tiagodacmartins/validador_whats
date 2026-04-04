# WhatsApp Validator GUI

Aplicativo desktop para validar números de telefone no WhatsApp em lote, com suporte a múltiplas contas simultâneas e cache em banco de dados PostgreSQL.

---

## Requisitos

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **Microsoft Edge** instalado (já vem no Windows 10/11)
- Uma conta WhatsApp ativa para escaneamento do QR Code

---

## Instalação

### Opção 1 — Clonar o repositório

```bash
git clone https://github.com/tiagodacmartins/validador_whats.git
cd validador_whats
npm install
npm start
```

### Opção 2 — Baixar o ZIP

1. Clique em **Code → Download ZIP** no GitHub
2. Extraia o arquivo
3. Abra um terminal na pasta extraída
4. Execute:

```bash
npm install
npm start
```

---

## Primeiro uso

### 1. Conectar o WhatsApp

Na aba **WhatsApp**, clique em **Adicionar conta**. Um QR Code será exibido — escaneie pelo celular em **WhatsApp → Dispositivos conectados → Conectar dispositivo**.

Aguarde a mensagem *"Conta conectada e pronta"* no log.

### 2. Selecionar o arquivo de entrada

Na aba **Validador**, clique em **Escolher arquivo(s)** ou arraste arquivos `.txt` para a área indicada.

**Formatos aceitos:**
- Uma linha por número: `5511999990000`
- Colunas separadas por `;` — o telefone deve estar na **primeira coluna**:  
  `5511999990000;Nome do Cliente;Empresa`

O número deve estar no formato brasileiro com DDD (10 ou 11 dígitos). O prefixo `55` é adicionado automaticamente se ausente.

### 3. Configurar e iniciar

Ajuste os parâmetros se necessário (os padrões já são seguros):

| Campo | Padrão | Descrição |
|---|---|---|
| Delay mínimo | 2000 ms | Intervalo mínimo entre consultas |
| Delay máximo | 5000 ms | Intervalo máximo entre consultas |
| Tamanho do lote | 150 | Consultas antes de pausar |
| Pausa entre lotes | 30000 ms | Tempo de pausa entre lotes |

Clique em **Iniciar validação**.

### 4. Resultados

Ao final (ou ao clicar em **Parar**), os arquivos são salvos automaticamente na pasta `output/` ou no diretório escolhido:

- **`.txt`** — linhas originais onde o número **tem** WhatsApp (sem cabeçalho)
- **`.csv`** — relatório completo com todos os números e status

---

## Banco de dados (opcional)

O app suporta cache em PostgreSQL (ex: Supabase) para evitar revalidar números já consultados.

Na aba **Banco de Telefones**, preencha as credenciais de conexão. Após conectar, o banco é reutilizado automaticamente nas próximas sessões.

Em build empacotado ou com `NODE_ENV=production`, conexões SSL usam `rejectUnauthorized: true` automaticamente.

**Tabela necessária:**

```sql
CREATE TABLE phone_cache (
  phone      TEXT PRIMARY KEY,
  has_wa     BOOLEAN NOT NULL,
  checked_at TIMESTAMP NOT NULL
);
```

---

## Múltiplas contas

Na aba **WhatsApp**, clique em **Adicionar conta** para incluir mais contas. Cada conta conectada processa um número simultaneamente — quanto mais contas, maior o throughput e menor o risco de bloqueio por conta individual.

---

## Pausar & Retomar

Durante uma validação, o botão **"|| Pausar"** é exibido. Clique nele para:
- Pausar a validação
- Salvar o progresso (resumeState)
- Baixar resultados parciais em ZIP

Depois, clique em **"↺ Retomar"** para continuar de onde parou — sem reprocessar os números já validados.

---

## Arquitetura

O app usa **3 processos Electron**:

```
┌─ MAIN (main.js)
│  ├─ Gerenciamento de janelas & IPC
│  ├─ WhatsApp Web.js clients (múltiplas contas)
│  ├─ Loop paralelo de validação
│  └─ PostgreSQL connection pool
│
├─ RENDERER (HTML/JavaScript)
│  ├─ whatsapp-validator-gui.html (principal)
│  ├─ banco-telefones.html (DB search)
│  └─ whatsapp-connect.html (QR code)
│
└─ PRELOAD (segurança)
   ├─ preload.js (principal)
   ├─ preload-banco.js (banco)
   └─ preload-connect.js (conexão)
```

**Fluxo de dados:**
1. Renderer clica botão → `ipcRenderer.invoke('start-validation', config)`
2. Main processa validação em loop paralelo com leitura via streaming
3. Main envia `webContents.send('progress', {...})` a cada linha processada
4. Main grava `.txt` e `.csv` incrementalmente em disco
5. Renderer atualiza tabela + contadores em tempo real

**Arquivos chave:**
- `main.js` — Lógica de validação, IPC handlers, WhatsApp clients
- `preload.js` — Ponte segura renderer ↔ main (contextBridge)
- `banco-telefones.html` — UI para cache PostgreSQL
- `whatsapp-validator-gui.html` — UI principal, 1220×860

---

## Banco de dados — Configuração

O arquivo `db-config.json` é **criado automaticamente** na primeira conexão:

```json
{
  "host": "seu-db.supabase.com",
  "port": 6543,
  "database": "postgres",
  "user": "postgres.xxxxx",
  "password": "seu_password",
  "ssl": true
}
```

**IMPORTANTE**: Este arquivo **não é commitado** (está em `.gitignore`). Cada máquina tem suas credenciais.

Se usar **Supabase**, copie as credenciais de: **Settings → Database → Connection pooling → Session mode**.

---

## ⚠️ Segurança & Boas Práticas

### Credenciais

- `db-config.json` e `credentials.json` **nunca são commitados**
- `.wwebjs_auth/` e `.wwebjs_cache/` também são ignorados
- Se você for publicar este código, **regenere** credenciais Supabase antes

### Contexto de Isolamento

- `contextIsolation: true` — Renderer ISO do Node.js
- `nodeIntegration: false` — Sem acesso direto a FS/Net
- `preload.js` usa `contextBridge.exposeInMainWorld()` — Bridge segura

### TLS no Banco

Certifique-se de que `ssl: true` está configurado. Exemplos:
- **Supabase**: SSL é obrigatório, já está ativado
- **PostgreSQL local**: Considere ativar se em rede pública

Quando o app está empacotado ou executando com `NODE_ENV=production`, o cliente PostgreSQL passa a validar o certificado do servidor com `rejectUnauthorized: true`.

### IPC Rate Limiting

- Canais mais caros (`start-validation`, `search-cache`, `revalidate-phone`, `validate-phones-manual`, metadados de arquivo) têm rate limiting no main process
- O objetivo é reduzir spam acidental da interface e abuso em caso de renderer comprometido
- Em estouro de limite, o retorno inclui `code: RATE_LIMITED`

### HTML Escaping

Todo texto inserido via `.innerHTML` passa por `escapeHtml()` para evitar XSS.

---

## Troubleshooting

### "Conta não conecta"

1. Verifique se o WhatsApp está logado no celular
2. Tente escanear o QR Code novamente — QR vence em ~30 segundos
3. Se persistir, verifique se há atualizações do WhatsApp Web

### "Banco de dados não conecta"

1. Copie as credenciais Supabase corretas (via Settings → Database)
2. Confirme que a rede permite porta 6543 (HTTPS)
3. Verifique se a tabela `phone_cache` existe — execute o SQL na documentação

### "Validação travou / não progride"

1. Verifique o **Log do Validador** — se estiver vazio, app prendeu
2. Pause a validação (botão "|| Pausar")
3. Tente retomar — se continuar preso, reinicie o app
4. Se repetir, tente com **menos contas** ou **mais delay** entre consultas

### "Out of memory / Arquivo muito grande"

- O pipeline principal agora lê arquivos por streaming e escreve resultados incrementalmente em disco
- Isso reduz drasticamente o uso de RAM mesmo com arquivos muito grandes
- Ainda vale manter espaço livre em disco suficiente para `.txt`, `.csv` e `.zip`

### "Resultado não aparece"

1. O arquivo `.csv` **sempre** é gerado
2. O arquivo `.txt` **só** contém linhas com WhatsApp
3. Se resultado vazio, significa nenhum número era válido no WhatsApp
4. Confirme o formato dos números — devem ser E.164 brasileiros

---

## Performance & Limites

| Métrica | Limite Típico | Notas |
|---------|-------|-------|
| Linhas por arquivo | Escala por streaming | Testado para leitura sem carregar tudo em RAM |
| Contas simultâneas | 5-10 | Mais = mais rápido, maior risco de bloqueio |
| Delay entre consultas | 2000-10000 ms | Defaults (2-5s) são seguros |
| Pausa entre lotes | 10000-60000 ms | Prevents anti-spam |
| Cache de sessão | Cresce por telefones consultados | Resultados de arquivo não ficam mais inteiros em memória |

---

## Desenvolvimento

### Estrutura de pastas

```
.
├── main.js                      # Processo principal
├── lib/                         # Utilitários de streaming, TLS e rate limiting
├── preload.js                   # Ponte principal
├── preload-banco.js             # Ponte banco
├── preload-connect.js           # Ponte conexão
├── whatsapp-validator-gui.html  # UI principal
├── banco-telefones.html         # UI banco
├── whatsapp-connect.html        # UI conexão
├── package.json                 # Dependências
├── tests/                       # Testes unitários Jest
└── build/
  ├── gen-icon.js              # Gerador de ícone
  ├── icon.ico                 # Ícone Win98
  └── make-dist.js             # Gerador ZIP
```

### Comandos

```bash
npm start
npm test
npm run dist
```

### Cobertura atual

- Testes unitários para rate limiting, decisão de TLS estrito e streaming de arquivo
- Build continua sendo gerado por `npm run dist`

### Rodando em dev

```bash
npm start
```

Abre em modo Electron com DevTools disponível.

### Gerar distribuível

```bash
npm run dist
```

→ `dist/Validador-WhatsApp-win-x64.zip`

### Checklist antes de commitar

- [ ] Não adicione `db-config.json` ou `credentials.json`
- [ ] Teste com múltiplas contas
- [ ] Verifique log para erros ou warnings
- [ ] Se mudou `/build`, execute `npm run dist` e teste o ZIP

---

## Licença

MIT — Veja LICENSE para detalhes.



