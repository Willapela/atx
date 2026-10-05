# ATX Config Panel

Painel web Node.js para administrar as configurações usadas pelo **ATX TUNNEL**.

O painel foi simplificado para manter somente o que participa do fluxo principal do app:

- visão geral e publicação;

- configurações gerais;

- layout, cores, logo e fundo;

- cadastro e edição de servidores;

- importação de configuração por arquivo ou URL;

- exportação da configuração;

- perfil e segurança da conta.

## Endpoint usado pelo ATX TUNNEL

O app deve consultar uma única URL:

```
https://painelatx.coneplusst.shop/atx/config
```

Também existe a rota equivalente:

```
https://painelatx.coneplusst.shop/atx/config.json
```

O JSON publicado contém a configuração no formato do ATX, incluindo servidores, portas, proxy, payload, SNI, Path, modo de conexão, cores, logo e fundo.

> O endpoint público precisa ser protegido com HTTPS. Como o JSON pode conter usuário e senha dos servidores, não publique credenciais em commits ou arquivos do repositório.

## Instalação rápida em uma VPS

Requisitos: Ubuntu ou Debian, acesso SSH e Node.js 18 ou superior.

```bash
git clone https://github.com/Willapela/atx.git
cd atx
npm ci --omit=dev
```

Defina uma chave forte e a URL pública do painel:

```bash
export PORT=2500
export APP_BASE_URL="https://painelatx.coneplusst.shop"
export JWT_SECRET="troque-por-uma-chave-longa-e-aleatoria"
node index.js
```

Abra o cadastro inicial em:

```
https://painelatx.coneplusst.shop/register
```

O primeiro usuário criado pode acessar o dashboard e publicar as configurações do ATX.

## Executar com PM2

```bash
npm install --global pm2
pm2 start index.js --name atx-panel --update-env
pm2 save
pm2 startup
```

Depois de alterar o código ou as variáveis de ambiente:

```bash
pm2 restart atx-panel --update-env
pm2 status
pm2 logs atx-panel --lines 50 --nostream
```

## Configuração persistente

Para não perder as variáveis após reiniciar a VPS, crie um arquivo `.env` local, fora dos commits públicos:

```
PORT=2500
APP_BASE_URL=https://painelatx.coneplusst.shop
JWT_SECRET=troque-por-uma-chave-longa-e-aleatoria
```

O arquivo `.env` não deve conter credenciais de servidores compartilhadas no GitHub.

## Domínio e DNS

Crie um registro DNS apontando o subdomínio para o IP público da VPS:

| Tipo | Nome | Valor |
| --- | --- | --- |
| `A` | `painelatx` | IP público da VPS |

O painel Node deve ficar escutando localmente na porta `2500`. O acesso público deve ser feito por HTTPS através de Nginx, Caddy ou outro proxy reverso.

## Proxy reverso com Nginx

Crie `/etc/nginx/sites-available/atx-panel`:

```
server {
    listen 80;
    listen [::]:80;
    server_name painelatx.coneplusst.shop;

    location / {
        proxy_pass http://127.0.0.1:2500;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 60s;
    }
}
```

Ative e valide:

```bash
sudo ln -s /etc/nginx/sites-available/atx-panel /etc/nginx/sites-enabled/atx-panel
sudo nginx -t
sudo systemctl reload nginx
```

Depois, emita o certificado HTTPS:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d painelatx.coneplusst.shop
sudo certbot renew --dry-run
```

## Importar uma configuração

No menu **Servidores**, existem duas opções:

1. **Importar**: carrega um arquivo JSON local;

1. **Importar URL**: lê uma URL HTTP/HTTPS que retorna um JSON de configuração reconhecível.

Após importar ou editar servidores, clique em **Salvar alterações**. A publicação em `/atx/config` é atualizada automaticamente.

## Segurança

- Use sempre HTTPS em produção.

- Defina um `JWT_SECRET` longo e aleatório.

- Não faça commit de `.env`, `data/users/` ou configurações com credenciais.

- Evite colocar usuário e senha de servidores em arquivos públicos.

- Restrinja a porta `2500` ao localhost quando usar Nginx.

- Faça backup seguro de `data/users/` antes de atualizar a VPS.

## Estrutura principal

```
index.js                    Backend Express e endpoint ATX
views/                      Telas EJS do painel
public/atx-mark.svg         Marca visual ATX
public/updates/atx-config   Configuração pública inicial
public/manus-routes.json    Rotas principais do painel
data/users/                 Dados locais das contas, não publicar
install.sh                  Instalação automatizada
```

## Rotas principais

| Rota | Função |
| --- | --- |
| `/login` | Login do painel |
| `/register` | Cadastro inicial |
| `/dashboard` | Gerenciamento ATX |
| `/atx/config` | JSON consumido pelo ATX TUNNEL |
| `/atx/config.json` | Alias do endpoint ATX |

## Recuperação de senha por e-mail

O login possui o link **Esqueci minha senha**. Para habilitar o envio, configure SMTP somente na VPS:

```
SMTP_HOST=smtp.seu-provedor.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=seu-email@seu-dominio.com
SMTP_PASS=sua-senha-ou-app-password
SMTP_FROM=ATX TUNNEL <seu-email@seu-dominio.com>
RESET_TOKEN_TTL_MINUTES=30
```

Nunca faça commit da senha SMTP no GitHub.

## Checklist de validação

```bash
node --check index.js
curl -fsS http://127.0.0.1:2500/atx/config
pm2 status
sudo nginx -t
```

O resultado esperado é o painel online na porta `2500`, com o endpoint ATX retornando um JSON válido e o domínio publicado via HTTPS.
