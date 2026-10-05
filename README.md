# ATX Config Panel

Painel web Node.js para gerenciamento de configurações de aplicativos, servidores e recursos de atualização. Esta versão inclui os recursos `appupdate`, `config`, `sms` e `theme`.

## Instalação rápida na VPS

O servidor precisa ter Ubuntu ou Debian, acesso SSH e Node.js 18 ou superior.

```bash
git clone https://github.com/Willapela/atx-panel-install.git
cd atx-panel-install
bash install.sh
```

Depois, abra `http://IP_DA_VPS:2000/register`, crie a primeira conta e faça login. Para produção, use HTTPS por meio de Nginx ou outro proxy reverso.

## Instalação manual

```bash
npm ci --omit=dev
export JWT_SECRET="troque-por-uma-chave-longa-e-aleatoria"
node index.js
```

Para manter o processo ativo, recomenda-se usar PM2:

```bash
npm install --global pm2
pm2 start index.js --name atx-panel
pm2 save
```

## Links dos recursos

Com o domínio configurado, os recursos ficam disponíveis nestas rotas:

| Recurso | URL relativa |
| --- | --- |
| Atualização do aplicativo | `/appupdate` |
| Configuração | `/config` |
| SMS | `/sms` |
| Tema | `/theme` |
| Manifesto | `/updates/manifest.json` |

Os arquivos estão em `public/updates/`. O arquivo `config` publicado é uma versão sanitizada, sem usuário, senha ou IP real. Substitua-o pela sua configuração privada somente na VPS e nunca faça commit de credenciais no GitHub.

## UUID de atualização unificado

Cada usuário possui um `updateUuid` persistente. O UUID é gerado automaticamente no cadastro e também é criado sob demanda para contas antigas. Ele aparece na visão geral e em **Meu Perfil**.

O aplicativo pode consultar apenas o endpoint abaixo para receber os links de configuração, appupdate, SMS e tema:

```
GET /u/<UUID>
```

As rotas derivadas `/u/<UUID>/config`, `/u/<UUID>/appupdate`, `/u/<UUID>/sms` e `/u/<UUID>/theme` entregam os payloads individuais. As rotas antigas por usuário continuam ativas para compatibilidade.

## Atualização automática e salvamento geral

O dashboard possui um único botão **Salvar alterações** na barra lateral. Ele salva de uma vez as configurações gerais, servidores, tema e SMS. O **pool CDN mantém seu próprio botão Salvar pool CDN**, porque seus links são administrados separadamente. Os botões individuais de configuração, tema e SMS foram removidos para evitar que uma parte do conteúdo fique salva e outra não.

As versões de configuração, tema e SMS sobem automaticamente somente quando o conteúdo correspondente é alterado. A versão do APK continua manual: `AppVersion`, `VersionName`, `Actualization` e `UpdateApk` só mudam quando o usuário envia ou ajusta os dados do aplicativo.

## Recuperação de senha por e-mail

O login possui o link **Esqueci minha senha**. O usuário informa o e-mail e recebe um link temporário. O token é armazenado somente como hash, expira por padrão em 30 minutos, pode ser utilizado uma única vez e é invalidado quando a senha é alterada.

Configure o envio SMTP na VPS com variáveis de ambiente. Nunca faça commit da senha SMTP no GitHub:

```bash
# URL pública usada pelo dashboard, UUIDs e recuperação de senha
export APP_BASE_URL="https://connect.dspeed.shop"
export SMTP_HOST="smtp.seu-provedor.com"
export SMTP_PORT="587"
export SMTP_SECURE="false"
export SMTP_USER="seu-email@seu-dominio.com"
export SMTP_PASS="sua-senha-ou-app-password"
export SMTP_FROM="ATX TUNNEL <seu-email@seu-dominio.com>"
export RESET_TOKEN_TTL_MINUTES="30"
```

Para SMTP em porta 465, use `SMTP_SECURE=true`. Em provedores que exigem autenticação de aplicativo, utilize a senha de aplicativo fornecida pelo provedor, não a senha principal da conta.

## Segurança

O banco de usuários fica em `data/users/` e é ignorado pelo Git. Defina sempre `JWT_SECRET` antes de colocar o painel na internet. Não use credenciais de servidores diretamente em um repositório público. Em produção, use HTTPS para impedir que credenciais e links de recuperação sejam transmitidos sem proteção.

## Estrutura principal

```
index.js                 Backend Express
views/                   Telas EJS
public/css/              Estilos
public/updates/          Arquivos appupdate, config, sms e theme
data/users/              Dados locais dos usuários, não publicados
install.sh               Instalação automatizada
```

## Configuração persistente na VPS

Para que o SMTP continue configurado depois de reiniciar o PM2 ou a VPS, copie o modelo e preencha os valores reais:

```bash
cp .env.example .env
nano .env
```

Depois reinicie o painel:

```bash
pm2 restart atx-panel --update-env
pm2 save
pm2 logs atx-panel --lines 30 --nostream
```

O log deve mostrar `SMTP de recuperação: OK (host:porta )`. Nunca envie o arquivo `.env` para o GitHub; ele já está protegido pelo `.gitignore`.

## Proxy reverso com Nginx

Esta seção mostra como publicar o **ATX Config Panel** com um domínio, sem expor diretamente a porta `2500` na internet. O exemplo considera que o painel está rodando na VPS em `127.0.0.1:2500` e que o domínio utilizado será `painel.seudominio.com`.

> **Importante:** substitua `painel.seudominio.com` pelo seu domínio real em todos os comandos e arquivos de configuração.

O fluxo recomendado é:

```
Usuário → HTTPS/Cloudflare → Nginx na VPS → ATX Config Panel em 127.0.0.1:2500
```

O Node.js continua escutando na porta `2500`, mas o usuário acessa somente o domínio pela porta HTTPS padrão. O Nginx recebe as requisições, encaminha os cabeçalhos necessários e mantém o suporte a conexões persistentes e WebSocket.

| Componente | Função | Exemplo |
| --- | --- | --- |
| ATX Config Panel | Aplicação Node.js | `127.0.0.1:2500` |
| Nginx | Proxy reverso | Portas `80` e `443` |
| Domínio | Endereço público | `painel.seudominio.com` |
| PM2 | Gerenciamento do processo | `atx-panel` |
| Cloudflare | DNS, proxy e proteção opcional | Registro tipo `A` |

### Pré-requisitos

Antes de configurar o proxy reverso, confirme que o painel está funcionando diretamente na VPS:

```bash
curl -I http://127.0.0.1:2500/login
pm2 status
```

O primeiro comando deve retornar uma resposta HTTP do painel. O processo do PM2 deve aparecer como `online`.

Também é necessário que o domínio possua um registro DNS apontando para o IP público da VPS. Se estiver usando Cloudflare, crie um registro como este:

| Tipo | Nome | Valor | Proxy |
| --- | --- | --- | --- |
| `A` | `painel` | IP público da VPS | Laranja ou cinza |

Durante os testes iniciais, o proxy da Cloudflare pode ficar desativado, com a nuvem cinza. Depois que o HTTPS funcionar diretamente na VPS, ele pode ser ativado.

### Instalar o Nginx

Em distribuições baseadas em Debian ou Ubuntu, execute:

```bash
sudo apt update
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

Se o firewall UFW estiver ativo, libere apenas SSH, HTTP e HTTPS:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw status
```

A porta `2500` não precisa ser liberada no firewall quando o Node.js escuta somente em `127.0.0.1`. Essa é a configuração preferível, pois o painel fica acessível externamente apenas através do Nginx.

### Criar a configuração do proxy reverso

Crie um arquivo para o domínio:

```bash
sudo nano /etc/nginx/sites-available/atx-panel
```

Cole o conteúdo abaixo, trocando o domínio:

```
server {
    listen 80;
    listen [::]:80;

    server_name painel.seudominio.com;

    location / {
        proxy_pass http://127.0.0.1:2500;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Necessário para WebSocket e conexões persistentes.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}
```

Ative o site e valide a configuração:

```bash
sudo ln -s /etc/nginx/sites-available/atx-panel /etc/nginx/sites-enabled/atx-panel
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Se `nginx -t` informar que a sintaxe está correta, abra `http://painel.seudominio.com` no navegador. Se o domínio não carregar, confirme o DNS, o IP da VPS e os logs:

```bash
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
```

### Ativar HTTPS com Certbot

Para gerar um certificado gratuito usando Let's Encrypt, instale o Certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d painel.seudominio.com
```

Quando solicitado, escolha a opção para redirecionar HTTP para HTTPS. Ao final, valide a renovação automática:

```bash
sudo certbot renew --dry-run
```

Após qualquer alteração manual no Nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### Usar Cloudflare na frente do Nginx

Se o DNS estiver na Cloudflare, ative o proxy laranja somente depois de o domínio funcionar diretamente com HTTPS. Em **SSL/TLS**, use o modo **Full (strict )** quando a VPS possuir um certificado válido do Let's Encrypt.

O caminho recomendado é:

```
Navegador HTTPS → Cloudflare HTTPS → Nginx HTTPS → Node.js HTTP local
```

Não configure o ATX Config Panel para escutar diretamente em uma porta pública diferente apenas por causa da Cloudflare. O Nginx deve continuar sendo o ponto de entrada na VPS, e o Node.js deve continuar no endereço local `127.0.0.1:2500`.

Se a Cloudflare apresentar erro `502` ou `504`, teste cada trecho separadamente:

```bash
curl -I http://127.0.0.1:2500/login
curl -I http://127.0.0.1/login -H 'Host: painel.seudominio.com'
curl -I https://painel.seudominio.com/login
```

O primeiro teste verifica o Node.js, o segundo verifica o Nginx localmente e o terceiro verifica DNS, HTTPS e Cloudflare.

### Ajustar o endereço público do painel

O endereço público configurado no `.env` deve usar HTTPS e o mesmo domínio publicado no proxy:

```
APP_BASE_URL=https://painel.seudominio.com
```

O `APP_BASE_URL` é importante para links públicos, recuperação de senha por e-mail e endereços de atualização usados pelo aplicativo. Depois de alterar o `.env`, reinicie o processo com as variáveis atualizadas:

```bash
cd ~/atx-panel
pm2 restart atx-panel --update-env
pm2 save
```

### Garantir que o PM2 permaneça ativo

Se o painel ainda não estiver cadastrado no PM2, execute na pasta do projeto:

```bash
cd ~/atx-panel
pm2 start index.js --name atx-panel
pm2 save
pm2 startup
```

O último comando exibirá outro comando específico para o sistema. Copie e execute esse comando com `sudo`, quando solicitado. Depois, confirme:

```bash
pm2 status
pm2 logs atx-panel --lines 50
```

Para atualizações futuras do painel:

```bash
cd ~/atx-panel
git pull origin main
npm install
pm2 restart atx-panel --update-env
pm2 save
```

### Erros comuns

| Sintoma | Causa provável | Verificação |
| --- | --- | --- |
| `502 Bad Gateway` | Node.js parado ou upstream incorreto | `pm2 status` e `curl http://127.0.0.1:2500/login` |
| `504 Gateway Timeout` | Aplicação travada ou timeout insuficiente | `pm2 logs atx-panel` e logs do Nginx |
| Domínio não abre | DNS ainda não propagado ou apontando para IP errado | `dig +short painel.seudominio.com` |
| Certbot falha | Portas 80/443 bloqueadas ou DNS incorreto | `sudo ufw status` e teste sem proxy Cloudflare |
| Loop de redirecionamento | Modo SSL incompatível na Cloudflare | Usar `Full (strict )` com certificado válido |
| Tela ou links incorretos | `APP_BASE_URL` ainda aponta para IP ou HTTP | Revisar `.env` e reiniciar com `--update-env` |
| WebSocket não conecta | Cabeçalhos `Upgrade` ausentes | Revisar `proxy_http_version` e os dois `proxy_set_header` |

### Checklist final

Antes de entregar o domínio para os usuários, confirme que o painel responde em HTTPS, o certificado está válido, o processo do PM2 está online, a porta `2500` não está exposta publicamente e o `.env` usa o domínio correto.

```bash
curl -I https://painel.seudominio.com/login
pm2 status
sudo nginx -t
sudo ss -lntp | grep -E ':80|:443|:2000'
```

O resultado esperado é o Nginx escutando nas portas `80` e `443`, enquanto o Node.js escuta localmente em `127.0.0.1:2500`.

Para consulta isolada, o mesmo conteúdo também está disponível em [GUIA-PROXY-REVERSO.md](GUIA-PROXY-REVERSO.md).

### Referências do proxy reverso

[1]: https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/ "NGINX — Setting up a reverse proxy"

[2]: https://certbot.eff.org/instructions "Certbot — Instructions"

[3]: https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/ "Cloudflare — SSL/TLS encryption modes"

[4]: https://pm2.keymetrics.io/docs/usage/startup/ "PM2 — Startup hook"
