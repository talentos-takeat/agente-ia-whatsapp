-- Estrutura inicial do agente de IA de atendimento interno via WhatsApp.
-- Todas as tabelas ficam com RLS ligado e sem políticas: só o backend
-- (service_role, dentro das Edge Functions) lê e escreve.

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- unaccent não é imutável; este wrapper permite usá-lo em colunas geradas
create or replace function public.sem_acento(text)
returns text
language sql immutable parallel safe strict
set search_path = ''
as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, $1) $$;

-- ---------------------------------------------------------------------------
-- Configuração do agente (identidade, tom de voz, limites). Editável sem deploy.
-- ---------------------------------------------------------------------------
create table public.config_agente (
  chave        text primary key,
  valor        jsonb not null,
  descricao    text,
  atualizado_em timestamptz not null default now()
);

insert into public.config_agente (chave, valor, descricao) values
  ('nome_agente',            '"Cria"',                 'Nome com que o agente se apresenta'),
  ('modelo',                 '"claude-opus-5-5"',      'Modelo Claude usado nas respostas'),
  ('esforco',                '"low"',                  'Esforço de raciocínio do modelo (low, medium, high)'),
  ('max_tokens_resposta',    '1500',                   'Teto de tokens gerados por resposta'),
  ('janela_agrupamento_seg', '5',                      'Segundos esperando mensagens seguidas antes de responder'),
  ('historico_mensagens',    '12',                     'Quantas mensagens anteriores entram como contexto'),
  ('limite_msgs_hora',       '30',                     'Mensagens processadas por contato por hora'),
  ('limite_msgs_dia',        '120',                    'Mensagens processadas por contato por dia'),
  ('teto_custo_diario_usd',  '15',                     'Acima disso a IA para e tudo vai para atendimento humano'),
  ('horas_modo_humano',      '24',                     'Por quanto tempo o bot fica pausado após encaminhar ou um humano responder'),
  ('tom_de_voz',             '""',                     'Guia de tom de voz (markdown)'),
  ('regras_extras',          '""',                     'Instruções adicionais ao agente (markdown)');

-- ---------------------------------------------------------------------------
-- Responsáveis pelo atendimento humano
-- ---------------------------------------------------------------------------
create table public.responsaveis (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  area       text not null check (area in ('financeiro', 'rh')),
  telefone   text not null,          -- só dígitos, com DDI: 5511999999999
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Contatos e conversas
-- ---------------------------------------------------------------------------
create table public.contatos (
  id                 uuid primary key default gen_random_uuid(),
  telefone           text not null unique,   -- só dígitos, com DDI
  nome               text,                   -- nome do perfil do WhatsApp
  bloqueado          boolean not null default false,
  criado_em          timestamptz not null default now(),
  ultimo_contato_em  timestamptz not null default now()
);

create table public.conversas (
  id                uuid primary key default gen_random_uuid(),
  contato_id        uuid not null references public.contatos(id) on delete cascade,
  modo              text not null default 'bot' check (modo in ('bot', 'humano')),
  modo_humano_ate   timestamptz,
  criada_em         timestamptz not null default now(),
  atualizada_em     timestamptz not null default now()
);
create unique index conversas_um_por_contato on public.conversas (contato_id);

-- ---------------------------------------------------------------------------
-- Mensagens (entrada e saída) com status de processamento e custo
-- ---------------------------------------------------------------------------
create table public.mensagens (
  id                uuid primary key default gen_random_uuid(),
  conversa_id       uuid not null references public.conversas(id) on delete cascade,
  contato_id        uuid not null references public.contatos(id) on delete cascade,
  direcao           text not null check (direcao in ('entrada', 'saida')),
  autor             text not null check (autor in ('contato', 'bot', 'humano')),
  provedor_msg_id   text,                     -- ID da mensagem no WhatsApp/UZAPI
  tipo              text not null default 'texto',
  conteudo          text,
  status            text not null,
  -- entrada: recebida | processando | respondida | ignorada | erro
  -- saida:   pendente | enviada | falhou
  resultado         text check (resultado in ('respondida', 'sem_resposta', 'pediu_contexto', 'encaminhada', 'limite', 'fora_escopo')),
  tentativas        int not null default 0,
  proxima_tentativa_em timestamptz,
  erro              text,
  resposta_de       uuid references public.mensagens(id),  -- saída aponta para a entrada que respondeu
  modelo            text,
  tokens_entrada    int,
  tokens_saida      int,
  tokens_cache_lidos int,
  tokens_cache_gravados int,
  custo_usd         numeric(10, 6),
  latencia_ms       int,
  fontes            jsonb,                    -- trechos da base usados na resposta
  criada_em         timestamptz not null default now(),
  processada_em     timestamptz
);
-- Impede processar a mesma mensagem duas vezes
create unique index mensagens_provedor_msg_id_unico
  on public.mensagens (provedor_msg_id) where provedor_msg_id is not null;
create index mensagens_conversa_data on public.mensagens (conversa_id, criada_em desc);
create index mensagens_fila on public.mensagens (status, proxima_tentativa_em)
  where direcao = 'entrada' and status in ('recebida', 'erro');

-- ---------------------------------------------------------------------------
-- Encaminhamentos para atendimento humano
-- ---------------------------------------------------------------------------
create table public.encaminhamentos (
  id               uuid primary key default gen_random_uuid(),
  conversa_id      uuid not null references public.conversas(id) on delete cascade,
  contato_id       uuid not null references public.contatos(id) on delete cascade,
  mensagem_id      uuid references public.mensagens(id),
  area             text not null check (area in ('financeiro', 'rh')),
  motivo           text not null check (motivo in ('sem_resposta', 'pediu_humano', 'sensivel', 'limite', 'erro')),
  resumo           text not null,
  responsavel_id   uuid references public.responsaveis(id),
  status           text not null default 'aberto' check (status in ('aberto', 'notificado', 'falha_notificacao', 'resolvido')),
  criado_em        timestamptz not null default now(),
  resolvido_em     timestamptz
);

-- ---------------------------------------------------------------------------
-- Avaliação de qualidade das respostas (para o painel futuro)
-- ---------------------------------------------------------------------------
create table public.avaliacoes (
  id           uuid primary key default gen_random_uuid(),
  mensagem_id  uuid not null references public.mensagens(id) on delete cascade,
  nota         int check (nota between 1 and 5),
  correta      boolean,
  comentario   text,
  avaliador    text,
  criado_em    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Log de eventos e erros (sem tokens, sem conteúdo sensível)
-- ---------------------------------------------------------------------------
create table public.eventos_log (
  id         bigint generated always as identity primary key,
  nivel      text not null check (nivel in ('info', 'aviso', 'erro')),
  origem     text not null,
  evento     text not null,
  detalhes   jsonb,
  criado_em  timestamptz not null default now()
);
create index eventos_log_data on public.eventos_log (criado_em desc);

-- ---------------------------------------------------------------------------
-- Base de conhecimento
-- ---------------------------------------------------------------------------
create table public.documentos (
  id             uuid primary key default gen_random_uuid(),
  titulo         text not null,
  area           text not null check (area in ('financeiro', 'rh', 'geral')),
  arquivo_path   text,                 -- caminho no Storage (bucket base-conhecimento)
  hash_conteudo  text,                 -- evita reindexar o que não mudou
  ativo          boolean not null default true,
  atualizado_em  timestamptz not null default now(),
  criado_em      timestamptz not null default now()
);

create table public.trechos (
  id            uuid primary key default gen_random_uuid(),
  documento_id  uuid not null references public.documentos(id) on delete cascade,
  ordem         int not null,
  secao         text,
  conteudo      text not null,
  busca         tsvector generated always as (
                  to_tsvector('portuguese', public.sem_acento(coalesce(secao, '') || ' ' || conteudo))
                ) stored
);
create index trechos_busca on public.trechos using gin (busca);

-- Perguntas e respostas curadas pelo time (têm prioridade na busca)
create table public.faq (
  id            uuid primary key default gen_random_uuid(),
  area          text not null check (area in ('financeiro', 'rh', 'geral')),
  pergunta      text not null,
  resposta      text not null,
  ativo         boolean not null default true,
  atualizado_em timestamptz not null default now(),
  busca         tsvector generated always as (
                  to_tsvector('portuguese', public.sem_acento(pergunta || ' ' || resposta))
                ) stored
);
create index faq_busca on public.faq using gin (busca);

-- Busca na base: FAQ + trechos, em português, sem acento, casando QUALQUER palavra
-- (o ranking favorece quem casa mais palavras). O agente reformula a pergunta
-- informal em termos de busca antes de chamar esta função.
create or replace function public.buscar_conhecimento(consulta text, limite int default 6)
returns table (fonte text, id uuid, titulo text, area text, conteudo text, relevancia real)
language sql stable
set search_path = public, extensions
as $$
  with q as (
    select nullif(replace(plainto_tsquery('portuguese', public.sem_acento(consulta))::text, '&', '|'), '')::tsquery as tsq,
           lower(public.sem_acento(consulta)) as texto
  )
  select * from (
    select 'faq'::text, f.id, f.pergunta, f.area,
           'Pergunta: ' || f.pergunta || E'\nResposta: ' || f.resposta,
           (coalesce(ts_rank_cd(f.busca, q.tsq), 0) * 2
             + similarity(lower(public.sem_acento(f.pergunta)), q.texto))::real
    from public.faq f, q
    where f.ativo
      and (f.busca @@ q.tsq or similarity(lower(public.sem_acento(f.pergunta)), q.texto) > 0.3)
    union all
    select 'documento'::text, t.id, d.titulo || coalesce(' > ' || t.secao, ''), d.area,
           t.conteudo,
           coalesce(ts_rank_cd(t.busca, q.tsq), 0)::real
    from public.trechos t
    join public.documentos d on d.id = t.documento_id and d.ativo, q
    where t.busca @@ q.tsq
  ) r
  order by 6 desc
  limit limite;
$$;

-- ---------------------------------------------------------------------------
-- Fila: reserva atômica das mensagens pendentes de uma conversa
-- ---------------------------------------------------------------------------
create or replace function public.reservar_mensagens(p_conversa_id uuid)
returns setof public.mensagens
language sql
set search_path = public
as $$
  update public.mensagens m
     set status = 'processando', tentativas = m.tentativas + 1
   where m.id in (
     select id from public.mensagens
      where conversa_id = p_conversa_id
        and direcao = 'entrada'
        and (status = 'recebida'
             or (status = 'erro' and tentativas < 4 and proxima_tentativa_em <= now())
             -- processamento que travou (função caiu no meio)
             or (status = 'processando' and tentativas < 4 and criada_em < now() - interval '5 minutes'))
      order by criada_em
      for update skip locked
   )
  returning m.*;
$$;

-- Conversas com mensagens paradas (para o reprocessamento periódico)
create or replace function public.conversas_pendentes(p_idade_seg int default 20)
returns table (conversa_id uuid)
language sql stable
set search_path = public
as $$
  select distinct conversa_id from public.mensagens
   where direcao = 'entrada'
     and ((status = 'recebida' and criada_em < now() - make_interval(secs => p_idade_seg))
          or (status = 'erro' and tentativas < 4 and proxima_tentativa_em <= now())
          or (status = 'processando' and criada_em < now() - interval '5 minutes'));
$$;

-- ---------------------------------------------------------------------------
-- Visões para o painel futuro
-- ---------------------------------------------------------------------------
create view public.vw_uso_diario with (security_invoker = true) as
select date_trunc('day', criada_em at time zone 'America/Sao_Paulo')::date as dia,
       count(*) filter (where direcao = 'entrada')                    as mensagens_recebidas,
       count(*) filter (where direcao = 'saida' and autor = 'bot')    as respostas_bot,
       count(distinct contato_id)                                     as contatos,
       count(*) filter (where resultado = 'sem_resposta')             as sem_resposta,
       count(*) filter (where resultado = 'encaminhada')              as encaminhadas,
       count(*) filter (where status in ('erro', 'falhou'))           as erros,
       coalesce(sum(custo_usd), 0)                                    as custo_usd,
       avg(latencia_ms) filter (where latencia_ms is not null)::int   as latencia_media_ms
  from public.mensagens
 group by 1;

create view public.vw_perguntas_sem_resposta with (security_invoker = true) as
select e.criada_em, e.conteudo as pergunta, s.resultado
  from public.mensagens s
  join public.mensagens e on e.id = s.resposta_de
 where s.resultado in ('sem_resposta', 'encaminhada');

-- ---------------------------------------------------------------------------
-- Segurança: RLS ligado em tudo, sem políticas; nada exposto a anon/authenticated
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['config_agente','responsaveis','contatos','conversas','mensagens',
                           'encaminhamentos','avaliacoes','eventos_log','documentos','trechos','faq']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

revoke all on public.vw_uso_diario, public.vw_perguntas_sem_resposta from anon, authenticated;
revoke execute on function public.sem_acento(text),
                         public.buscar_conhecimento(text, int),
                         public.reservar_mensagens(uuid),
                         public.conversas_pendentes(int)
  from public, anon, authenticated;

-- Bucket privado para os documentos da base de conhecimento
insert into storage.buckets (id, name, public)
values ('base-conhecimento', 'base-conhecimento', false)
on conflict (id) do nothing;
