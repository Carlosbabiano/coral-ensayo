-- Contabilidad de la coral · tanda 4: subvenciones (cobros, gastos justificados, documentos) y memoria anual.

create table public.subvenciones (
  id uuid primary key default gen_random_uuid(),
  organismo text not null check (length(trim(organismo)) > 0),
  convocatoria text not null check (length(trim(convocatoria)) > 0),
  ejercicio int not null check (ejercicio between 2000 and 2100),
  solicitado numeric(12,2) check (solicitado >= 0),
  concedido numeric(12,2) check (concedido >= 0),
  fecha_solicitud date, fecha_resolucion date, plazo_justificacion date, fecha_justificada date,
  estado text not null default 'solicitada' check (estado in ('solicitada', 'concedida', 'denegada', 'justificada')),
  notas text,
  creado_por uuid references public.perfiles(id) default auth.uid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index on public.subvenciones (ejercicio);
create index on public.subvenciones (creado_por);

-- Los cobros de una subvención son ingresos del libro enlazados a ella
alter table public.movimientos add column subvencion_id uuid references public.subvenciones(id);
create index on public.movimientos (subvencion_id);

-- Gastos del libro asignados a una subvención (enteros o en parte)
create table public.subvencion_gastos (
  id uuid primary key default gen_random_uuid(),
  subvencion_id uuid not null references public.subvenciones(id) on delete cascade,
  movimiento_id uuid not null references public.movimientos(id),
  importe numeric(12,2) not null check (importe > 0),
  creado_por uuid references public.perfiles(id) default auth.uid(),
  creado_en timestamptz not null default now(),
  unique (subvencion_id, movimiento_id)
);
create index on public.subvencion_gastos (movimiento_id);
create index on public.subvencion_gastos (creado_por);

create or replace function privado.comprobar_imputacion() returns trigger
language plpgsql security definer set search_path = '' as $$
declare m public.movimientos; v_otras numeric;
begin
  select * into m from public.movimientos where id = new.movimiento_id;
  if m.tipo <> 'gasto' or m.anulado then
    raise exception 'Solo se pueden asignar gastos vigentes del libro.' using errcode = 'check_violation';
  end if;
  select coalesce(sum(importe), 0) into v_otras from public.subvencion_gastos where movimiento_id = new.movimiento_id and id <> new.id;
  if v_otras + new.importe > m.importe then
    raise exception 'Del gasto nº % (% €) solo quedan % € sin asignar a otras subvenciones.', m.numero,
      replace(m.importe::text, '.', ','), replace((m.importe - v_otras)::text, '.', ',')
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger comprobar_imputacion before insert or update on public.subvencion_gastos
  for each row execute function privado.comprobar_imputacion();

-- Documentos de la subvención (bases, resolución, justificación…), en el almacén de justificantes
create table public.subvencion_documentos (
  id uuid primary key default gen_random_uuid(),
  subvencion_id uuid not null references public.subvenciones(id) on delete cascade,
  ruta text not null unique,
  nombre text not null,
  tipo_mime text,
  tamano int,
  subido_por uuid references public.perfiles(id) default auth.uid(),
  subido_en timestamptz not null default now()
);
create index on public.subvencion_documentos (subvencion_id);
create index on public.subvencion_documentos (subido_por);

-- Textos de la memoria anual (comentarios y firmantes)
create table public.memorias (
  ejercicio int primary key,
  comentarios text,
  presidente text,
  tesorero text,
  actualizado_en timestamptz not null default now()
);

create trigger historial after insert or update or delete on public.subvenciones for each row execute function privado.registrar_historial();
create trigger historial after insert or update or delete on public.subvencion_gastos for each row execute function privado.registrar_historial();
create trigger historial after insert or update or delete on public.subvencion_documentos for each row execute function privado.registrar_historial();

alter table public.subvenciones enable row level security;
alter table public.subvencion_gastos enable row level security;
alter table public.subvencion_documentos enable row level security;
alter table public.memorias enable row level security;
revoke all on public.subvenciones, public.subvencion_gastos, public.subvencion_documentos, public.memorias from anon;

create policy "ver" on public.subvenciones for select to authenticated using ((select privado.es_miembro()));
create policy "crear" on public.subvenciones for insert to authenticated with check ((select privado.puede_editar()));
create policy "editar" on public.subvenciones for update to authenticated using ((select privado.puede_editar())) with check ((select privado.puede_editar()));
create policy "borrar" on public.subvenciones for delete to authenticated using ((select privado.puede_editar()));
create policy "ver" on public.subvencion_gastos for select to authenticated using ((select privado.es_miembro()));
create policy "crear" on public.subvencion_gastos for insert to authenticated with check ((select privado.puede_editar()));
create policy "editar" on public.subvencion_gastos for update to authenticated using ((select privado.puede_editar())) with check ((select privado.puede_editar()));
create policy "quitar" on public.subvencion_gastos for delete to authenticated using ((select privado.puede_editar()));
create policy "ver" on public.subvencion_documentos for select to authenticated using ((select privado.es_miembro()));
create policy "crear" on public.subvencion_documentos for insert to authenticated with check ((select privado.puede_editar()));
create policy "quitar" on public.subvencion_documentos for delete to authenticated using ((select privado.puede_editar()));
create policy "ver" on public.memorias for select to authenticated using ((select privado.es_miembro()));
create policy "crear" on public.memorias for insert to authenticated with check ((select privado.puede_editar()));
create policy "editar" on public.memorias for update to authenticated using ((select privado.puede_editar())) with check ((select privado.puede_editar()));

-- El borrado de datos de prueba también vacía subvenciones y memorias
create or replace function public.borrar_datos_prueba(p_empezar boolean default false) returns text[]
language plpgsql security definer set search_path = '' as $$
declare v_rutas text[];
begin
  if privado.mi_rol() is distinct from 'admin' then
    raise exception 'Solo el administrador puede borrar los datos de prueba.' using errcode = 'insufficient_privilege';
  end if;
  if not (select modo_pruebas from public.ajustes where id = 1) then
    raise exception 'La contabilidad ya está en uso real: no se pueden borrar datos.' using errcode = 'check_violation';
  end if;
  select coalesce(array_agg(x), '{}') into v_rutas from (
    select ruta as x from public.justificantes
    union all select ruta from public.subvencion_documentos
    union all select firma_persona from public.recibos where firma_persona is not null
    union all select firma_coral from public.recibos where firma_coral is not null) t;
  delete from public.subvencion_gastos where true;
  delete from public.subvencion_documentos where true;
  delete from public.recibos where true;
  delete from public.documentos where tipo <> 'presupuesto';
  delete from public.documentos where true;
  delete from public.clientes where true;
  delete from public.justificantes where true;
  delete from public.conciliaciones where true;
  delete from public.movimientos where true;
  delete from public.subvenciones where true;
  delete from public.memorias where true;
  delete from public.historial where true;
  if p_empezar then
    update public.ajustes set modo_pruebas = false, en_uso_desde = current_date where id = 1;
  end if;
  return v_rutas;
end $$;
