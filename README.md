# Agente de IA – atendimento interno via WhatsApp

Agente que responde dúvidas de colaboradores da Takeat pelo WhatsApp (UZAPI),
usando uma base de conhecimento interna, e encaminha para atendimento humano
(Financeiro: Júlia Rocon · RH: Maria Luiza) quando não sabe responder ou o caso é sensível.

## Arquitetura

```
WhatsApp → UZAPI → webhook (Edge Function "receber")
   valida segredo · descarta duplicadas · grava · responde 200
        ↓
   fila no Postgres (tabela mensagens, status "recebida")
        ↓
   Edge Function "processar": histórico + busca na base + Claude
        ↓
   resposta pela UZAPI  ·  ou encaminhamento para humano
   pg_cron: reprocessa mensagens paradas ou com erro (até 4 tentativas)
```

Tudo roda no Supabase (banco, funções, agendamento, storage).

## Estrutura

- `supabase/migrations/` – estrutura do banco
- `supabase/functions/` – Edge Functions (a partir da etapa 3)
- `.env.example` – nomes dos segredos (os valores ficam só em Supabase → Edge Functions → Secrets)

## Configuração sem deploy

- `config_agente`: nome do agente, modelo, limites, teto de custo, tom de voz
- `responsaveis`: quem recebe os encaminhamentos
- `faq` e `documentos`/`trechos`: base de conhecimento

## Segurança

- RLS ligado em todas as tabelas, sem políticas: só o backend (service_role) acessa.
- Nenhum segredo no repositório. Logs sem tokens e sem conteúdo sensível.
