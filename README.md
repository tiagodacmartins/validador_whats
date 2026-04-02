\# WhatsApp Validator GUI



\## O que este projeto faz

\- Lê TXT simples ou TXT com colunas separadas por `;`

\- No formato delimitado, usa a primeira coluna como telefone

\- Normaliza o telefone para consulta

\- Valida via WhatsApp Web (`getNumberId`)

\- Exporta:

&#x20; - `whatsapp\_validos.txt` com \*\*somente as linhas originais válidas\*\*, sem cabeçalho

&#x20; - `whatsapp\_validos.csv` com relatório completo



\## Formato suportado



Exemplo de linha:



5511951331472;4226136775;NOME LOJA;RESPONSAVEL;CARTEIRA;EMPRESA;CNPJ



A saída TXT manterá a linha inteira acima apenas se o telefone da primeira coluna tiver WhatsApp.



\## Anti-risco incluído

\- Delay aleatório mínimo/máximo

\- Lote configurável

\- Pausa automática entre lotes

\- Botão para parar



\## Como rodar



```bash

npm install

npm start

```



\## Requisitos

\- Node.js 18+

\- Chrome/Chromium instalado para o WhatsApp Web rodar via Puppeteer

