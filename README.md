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

Na aba **WhatsApp**, clique em **Adicionar conta** para incluir mais contas. O validador distribui as consultas em round-robin entre todas as contas conectadas, reduzindo o risco de bloqueio.

---

## Gerar distribuível (ZIP)

```bash
npm run dist
```

Gera `Validador-WhatsApp-win-x64.zip` na raiz do projeto.

