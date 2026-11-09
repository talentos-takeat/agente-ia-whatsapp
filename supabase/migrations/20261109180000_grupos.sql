-- Atendimento em grupos de WhatsApp autorizados.
-- O grupo vira um "contato" do tipo grupo (telefone = ID do grupo, ex.: 1203...@g.us) com a sua conversa;
-- cada mensagem guarda em contato_id quem de fato escreveu (a pessoa), para métricas e limites por pessoa.

alter table public.contatos
  add column tipo text not null default 'pessoa' check (tipo in ('pessoa', 'grupo'));

comment on column public.contatos.telefone is
  'Pessoa: só dígitos com DDI. Grupo: ID do grupo (...@g.us). Pessoa sem número conhecido: ID @lid.';

insert into public.config_agente (chave, valor, descricao) values
  ('grupos_permitidos', '["120363432479970494@g.us"]',
   'IDs dos grupos em que o robô responde (todas as mensagens). Outros grupos são ignorados.')
on conflict (chave) do nothing;
