-- Crea un unico Lote general para acumular cantidades. Sus actividades
-- conservan el puntaje y la visibilidad en historiales, pero la aplicacion usa
-- es_general para excluirlas de graficas, calculos, reportes y documentos.

begin;

alter table public.lotes
  add column if not exists es_general boolean not null default false;

-- Los lotes ordinarios siguen exigiendo un responsable desde la aplicacion.
-- El lote administrado por el sistema no necesita uno.
alter table public.lotes
  alter column usuario_id drop not null;

do $$
declare
  varios_id bigint;
  lote_general_id bigint;
begin
  select id
    into varios_id
  from public.marcas
  where lower(btrim(nombre)) = 'varios'
  order by id
  limit 1;

  if varios_id is null then
    -- Algunas instalaciones antiguas no tienen la columna marcas.activo.
    -- Insertar solo el nombre funciona en ambos esquemas (cuando activo existe,
    -- su valor por defecto es true).
    insert into public.marcas (nombre)
    values ('VARIOS')
    returning id into varios_id;
  end if;

  -- Si la instalacion si cuenta con marcas.activo, garantiza que VARIOS quede
  -- disponible. SQL dinamico evita referenciar una columna inexistente.
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'marcas'
      and column_name = 'activo'
  ) then
    execute 'update public.marcas set activo = true where id = $1'
      using varios_id;
  end if;

  select id
    into lote_general_id
  from public.lotes
  where es_general = true
     or upper(btrim(codigo_lote)) = 'LOTE GENERAL'
  order by es_general desc, id
  limit 1;

  if lote_general_id is null then
    insert into public.lotes (
      codigo_lote,
      cantidad_lote,
      marca_id,
      fecha_ingreso,
      proveedor,
      usuario_id,
      estado,
      es_general
    ) values (
      'LOTE GENERAL',
      0,
      varios_id,
      (now() at time zone 'America/Lima')::date,
      'SISTEMA',
      null,
      'pendiente',
      true
    )
    returning id into lote_general_id;
  else
    update public.lotes
    set codigo_lote = 'LOTE GENERAL',
        cantidad_lote = 0,
        marca_id = varios_id,
        proveedor = 'SISTEMA',
        usuario_id = null,
        estado = 'pendiente',
        fecha_trabajo = null,
        fecha_fin_clasificado = null,
        fecha_inicio_etiquetado = null,
        fecha_completada = null,
        es_general = true
    where id = lote_general_id;
  end if;

  update public.lotes
  set es_general = false
  where id <> lote_general_id
    and es_general = true;
end;
$$;

create unique index if not exists idx_lotes_unico_general
  on public.lotes (es_general)
  where es_general = true;

comment on column public.lotes.es_general is
  'Identifica el lote acumulador excluido de graficas, calculos, reportes y documentos.';

notify pgrst, 'reload schema';

commit;
