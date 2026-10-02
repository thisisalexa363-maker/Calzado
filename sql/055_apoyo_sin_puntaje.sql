-- El apoyo conserva cantidades, pero nunca obtiene puntos.
-- Ejecutar despues de 054_apoyo_en_usuarios.sql.
begin;

create or replace function public.forzar_puntaje_cero_apoyo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.puntaje is not null and exists (
    select 1 from public.usuarios
    where id = new.trabajador_id and tipo = 'Apoyo'
  ) then
    new.puntaje := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_registro_apoyo_sin_puntaje on public.registros_tareas_jefe_equipo;
create trigger trg_registro_apoyo_sin_puntaje
before insert or update on public.registros_tareas_jefe_equipo
for each row execute function public.forzar_puntaje_cero_apoyo();

update public.registros_tareas_jefe_equipo r
set puntaje = 0
from public.usuarios u
where r.trabajador_id = u.id and u.tipo = 'Apoyo'
  and r.puntaje is distinct from 0 and r.puntaje is not null;

create or replace function public.forzar_puntaje_cero_tarea_apoyo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.usuarios
    where id = new.usuario_id and tipo = 'Apoyo'
  ) then
    new.puntaje := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_tarea_apoyo_sin_puntaje on public.registros_tareas;
create trigger trg_tarea_apoyo_sin_puntaje
before insert or update on public.registros_tareas
for each row execute function public.forzar_puntaje_cero_tarea_apoyo();

update public.registros_tareas r
set puntaje = 0
from public.usuarios u
where r.usuario_id = u.id and u.tipo = 'Apoyo' and r.puntaje is distinct from 0;

do $$
begin
  if to_regclass('public.registro_actividades') is not null then
    drop trigger if exists trg_actividad_legacy_apoyo_sin_puntaje on public.registro_actividades;
    create trigger trg_actividad_legacy_apoyo_sin_puntaje
    before insert or update on public.registro_actividades
    for each row execute function public.forzar_puntaje_cero_apoyo();

    update public.registro_actividades a
    set puntaje = 0
    from public.usuarios u
    where a.trabajador_id = u.id and u.tipo = 'Apoyo' and a.puntaje is distinct from 0;
  end if;
end;
$$;

do $$
begin
  if to_regclass('public.actividades_jefe_equipo') is not null then
    drop trigger if exists trg_actividad_apoyo_sin_puntaje on public.actividades_jefe_equipo;
    create trigger trg_actividad_apoyo_sin_puntaje
    before insert or update on public.actividades_jefe_equipo
    for each row execute function public.forzar_puntaje_cero_apoyo();

    update public.actividades_jefe_equipo a
    set puntaje = 0
    from public.usuarios u
    where a.trabajador_id = u.id and u.tipo = 'Apoyo'
      and a.puntaje is distinct from 0 and a.puntaje is not null;
  end if;
end;
$$;

create or replace function public.forzar_puntaje_cero_historial_apoyo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.puntaje is not null and exists (
    select 1
    from public.actividades_jefe_equipo a
    join public.usuarios u on u.id = a.trabajador_id
    where a.id = new.actividad_id and u.tipo = 'Apoyo'
  ) then
    new.puntaje := 0;
  end if;
  return new;
end;
$$;

do $$
begin
  if to_regclass('public.actividades_jefe_equipo_historial') is not null then
    drop trigger if exists trg_historial_apoyo_sin_puntaje on public.actividades_jefe_equipo_historial;
    create trigger trg_historial_apoyo_sin_puntaje
    before insert or update on public.actividades_jefe_equipo_historial
    for each row execute function public.forzar_puntaje_cero_historial_apoyo();

    update public.actividades_jefe_equipo_historial h
    set puntaje = 0
    from public.actividades_jefe_equipo a, public.usuarios u
    where h.actividad_id = a.id and a.trabajador_id = u.id and u.tipo = 'Apoyo'
      and h.puntaje is distinct from 0 and h.puntaje is not null;
  end if;
end;
$$;

commit;
