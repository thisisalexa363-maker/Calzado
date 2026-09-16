-- Separa el comentario de cada guia de la observacion general del registro.
-- Es seguro ejecutar esta migracion varias veces.

begin;

alter table public.registros_tareas
  add column if not exists detalle_guia text;

comment on column public.registros_tareas.detalle_guia is
  'Comentario opcional correspondiente unicamente a la guia de esta fila.';

grant select, insert, update, delete on public.registros_tareas to service_role;

commit;

notify pgrst, 'reload schema';
