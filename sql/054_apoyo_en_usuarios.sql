-- Unifica el personal de apoyo en usuarios y conserva sus registros anteriores.
-- Ejecutar una sola vez despues de las migraciones ya aplicadas; no requiere 051/052.
begin;

alter table public.usuarios
  add column if not exists tipo text not null default 'Normal',
  add column if not exists nombres text,
  add column if not exists apellidos text,
  add column if not exists datos_legado_apoyo jsonb,
  add column if not exists apoyo_origen_id bigint;

alter table public.usuarios
  alter column email drop not null,
  alter column password_hash drop not null;

alter table public.usuarios drop constraint if exists usuarios_tipo_check;
alter table public.usuarios add constraint usuarios_tipo_check
  check (tipo in ('Normal', 'Apoyo'));

alter table public.usuarios drop constraint if exists usuarios_apoyo_sin_acceso_check;
alter table public.usuarios add constraint usuarios_apoyo_sin_acceso_check
  check (tipo <> 'Apoyo' or (email is null and password_hash is null));

do $$
begin
  if to_regclass('public.personal_apoyo') is not null then
    alter table public.personal_apoyo
      add column if not exists nombres text,
      add column if not exists apellidos text,
      add column if not exists activo boolean not null default true;

    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'personal_apoyo' and column_name = 'nombre'
    ) then
      execute $fill$
        update public.personal_apoyo
        set nombres = coalesce(nullif(btrim(nombres), ''), split_part(btrim(nombre), ' ', 1)),
            apellidos = coalesce(nullif(btrim(apellidos), ''),
              nullif(btrim(substr(btrim(nombre), length(split_part(btrim(nombre), ' ', 1)) + 1)), ''),
              'Sin especificar')
        where nombres is null or apellidos is null
      $fill$;
    end if;

    insert into public.usuarios (nombre, nombres, apellidos, dni, rol, tipo, activo, created_at, datos_legado_apoyo, apoyo_origen_id)
    select
      coalesce(nullif(btrim(concat_ws(' ', p.nombres, p.apellidos)), ''), 'Apoyo ' || p.id),
      coalesce(nullif(btrim(p.nombres), ''), 'Apoyo'),
      coalesce(nullif(btrim(p.apellidos), ''), 'Sin especificar'),
      p.dni, 'operante', 'Apoyo', coalesce(p.activo, true), coalesce(p.created_at, now()), to_jsonb(p), p.id
    from public.personal_apoyo p
    where not exists (select 1 from public.usuarios u where u.apoyo_origen_id = p.id);

    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'registros_tareas_jefe_equipo'
        and column_name = 'personal_apoyo_id'
    ) then
      update public.registros_tareas_jefe_equipo r
      set trabajador_id = u.id, personal_apoyo_id = null
      from public.usuarios u
      where r.personal_apoyo_id = u.apoyo_origen_id and u.tipo = 'Apoyo';
      if exists (select 1 from public.registros_tareas_jefe_equipo where personal_apoyo_id is not null) then
        raise exception 'Hay tareas de apoyo sin usuario migrado; no se elimina la tabla anterior';
      end if;
      alter table public.registros_tareas_jefe_equipo drop column personal_apoyo_id;
      alter table public.registros_tareas_jefe_equipo alter column trabajador_id set not null;
    end if;

    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'registro_errores'
        and column_name = 'personal_apoyo_id'
    ) then
      update public.registro_errores r
      set usuario_id = u.id, personal_apoyo_id = null
      from public.usuarios u
      where r.personal_apoyo_id = u.apoyo_origen_id and u.tipo = 'Apoyo';
      if exists (select 1 from public.registro_errores where personal_apoyo_id is not null) then
        raise exception 'Hay incidencias de apoyo sin usuario migrado; no se elimina la tabla anterior';
      end if;
      alter table public.registro_errores drop column personal_apoyo_id;
      alter table public.registro_errores
        drop constraint if exists registro_errores_responsable_unico;
      alter table public.registro_errores
        add constraint registro_errores_responsable_unico
        check (num_nonnulls(usuario_id, area_id) = 1) not valid;
    end if;

    drop table public.personal_apoyo;
  end if;
end $$;

alter table public.usuarios drop column if exists apoyo_origen_id;
create unique index if not exists usuarios_apoyo_dni_unique
  on public.usuarios (dni) where tipo = 'Apoyo' and dni is not null;

commit;
notify pgrst, 'reload schema';
