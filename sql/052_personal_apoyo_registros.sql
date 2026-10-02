-- Permite asignar registros de tiempo e incidencias a personal de apoyo.
begin;

alter table public.registros_tareas_jefe_equipo
  add column if not exists personal_apoyo_id bigint references public.personal_apoyo(id) on delete restrict;
alter table public.registros_tareas_jefe_equipo
  alter column trabajador_id drop not null;
alter table public.registros_tareas_jefe_equipo
  drop constraint if exists registros_jefe_equipo_responsable_valido;
alter table public.registros_tareas_jefe_equipo
  add constraint registros_jefe_equipo_responsable_valido
  check ((trabajador_id is not null) <> (personal_apoyo_id is not null));

create index if not exists registros_jefe_equipo_apoyo_idx
  on public.registros_tareas_jefe_equipo(personal_apoyo_id, hora_inicio desc);

-- La misma proteccion horaria que existe para usuarios internos.
create extension if not exists btree_gist;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'registros_jefe_equipo_apoyo_sin_solapamiento') then
    alter table public.registros_tareas_jefe_equipo
      add constraint registros_jefe_equipo_apoyo_sin_solapamiento
      exclude using gist (personal_apoyo_id with =, tstzrange(hora_inicio, hora_fin, '[)') with &&)
      where (personal_apoyo_id is not null and hora_inicio is not null and hora_fin is not null);
  end if;
end $$;

alter table public.registro_errores
  add column if not exists personal_apoyo_id bigint references public.personal_apoyo(id) on delete restrict;
alter table public.registro_errores
  drop constraint if exists registro_errores_responsable_unico;
alter table public.registro_errores
  add constraint registro_errores_responsable_unico
  check (num_nonnulls(usuario_id, personal_apoyo_id, area_id) = 1) not valid;
create index if not exists registro_errores_apoyo_idx on public.registro_errores(personal_apoyo_id);

commit;
notify pgrst, 'reload schema';
