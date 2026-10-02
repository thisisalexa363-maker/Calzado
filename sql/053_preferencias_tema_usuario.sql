-- Preferencias visuales privadas de cada usuario.
create table if not exists public.preferencias_tema_usuario (
  usuario_id bigint primary key references public.usuarios(id) on delete cascade,
  tema text not null default 'default'
    check (tema in ('default', 'purple', 'pink', 'gold', 'green', 'custom')),
  colores_personalizados jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.preferencias_tema_usuario enable row level security;
revoke all on public.preferencias_tema_usuario from anon, authenticated;
grant select, insert, update on public.preferencias_tema_usuario to service_role;
notify pgrst, 'reload schema';
