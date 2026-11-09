-- Segredos internos no Vault, leitura restrita ao backend, e rotina de reprocessamento.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Segredos gerados dentro do banco (nunca passam pelo repositório)
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'webhook_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'webhook_secret',
                                'Segredo na URL do webhook da UZAPI');
  end if;
  if not exists (select 1 from vault.secrets where name = 'internal_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'internal_secret',
                                'Autentica o pg_cron na função processar-pendentes');
  end if;
end $$;

create or replace function public.ler_segredo(p_nome text)
returns text
language sql stable security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets
   where name = p_nome and p_nome in ('webhook_secret', 'internal_secret');
$$;
revoke execute on function public.ler_segredo(text) from public, anon, authenticated;
grant execute on function public.ler_segredo(text) to service_role;

-- Registra o formato (sem valores) dos webhooks recebidos, para validar a integração
insert into public.config_agente (chave, valor, descricao) values
  ('registrar_formato_webhook', 'true', 'Grava no eventos_log a estrutura (sem dados) de cada webhook recebido')
on conflict (chave) do nothing;

-- A cada minuto: reprocessa mensagens paradas ou com erro
select cron.schedule(
  'processar-pendentes',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://lbnhzercupemlliueuyq.supabase.co/functions/v1/processar-pendentes',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Limpeza: respostas do pg_net com mais de 1 dia
select cron.schedule('limpar-net-respostas', '0 4 * * *',
  $$ delete from net._http_response where created < now() - interval '1 day' $$);
