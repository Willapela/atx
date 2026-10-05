# ATX Config Panel

## Direção
Versão derivada do ATX Config Panel, focada em publicar configurações no formato reconhecido pelo ATX TUNNEL. A interface existente de servidores, tema e publicação será preservada para reduzir risco e acelerar a adaptação.

## Design
- Movimento: painel operacional escuro, compacto e técnico.
- Princípios: hierarquia clara, edição rápida, feedback imediato e foco em configuração.
- Paleta: base neutra do ATX com vermelho ATX como ação principal.
- Layout: navegação lateral e áreas de edição por contexto, mantendo o paradigma do painel original.
- Interação: salvar uma vez, publicar automaticamente e disponibilizar endpoint estável.

## Implementação
- Backend Express existente do ATX.
- Persistência por usuário em `data/users`.
- Conversor interno ATX -> ATX.
- Endpoint público `/atx/config` e cópia em `public/updates/atx-config`.
- Porta padrão 2500, configurável por `PORT`.
