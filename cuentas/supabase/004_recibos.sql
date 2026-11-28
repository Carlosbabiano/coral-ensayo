-- Contabilidad de la coral · tanda 3: recibos firmados en pantalla.
-- Recibo de pago (la coral paga a alguien en mano: firma quien recibe) y recibo de cobro (la coral cobra en mano:
-- firma el tesorero). Al crearlo se apunta solo en el libro; un recibo firmado no se modifica, solo se anula.

alter table public.ajustes add column localidad text default 'Mengíbar';

create table public.recibos (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('pago', 'cobro')),
  ejercicio int not null,
  numero int not null,
  codigo text not null,
  fecha date not null,
  persona text not null check (length(trim(persona)) > 0),
  dni text,
  importe numeric(12,2) not null check (importe > 0),
  concepto text not null check (length(trim(concepto)) > 0),
  movimiento_id uuid references public.movimientos(id),
  documento_id uuid references public.documentos(id),     -- si es el recibo del cobro en mano de una factura
  firma_persona text,                                      -- rutas de las firmas (PNG) en el almacén
  firma_coral text,
  firmante_coral text,
  pdf_ruta text,
  anulado boolean not null default false,
  motivo_anulacion text,
  creado_por uuid references public.perfiles(id) default auth.uid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (ejercicio, numero),
  check (tipo <> 'pago' or firma_persona is not null),
  check (tipo <> 'cobro' or firma_coral is not null)
);
create index on public.recibos (ejercicio, numero desc);
create index on public.recibos (movimiento_id);
create index on public.recibos (documento_id);
create index on public.recibos (creado_por);

create or replace function privado.preparar_recibo() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.ejercicio := extract(year from new.fecha)::int;
    perform pg_advisory_xact_lock(hashtext('recibos-' || new.ejercicio));
    select coalesce(max(numero), 0) + 1 into new.numero from public.recibos where ejercicio = new.ejercicio;
    new.codigo := 'RC-' || new.ejercicio || '-' || lpad(new.numero::text, 3, '0');
    new.creado_por := auth.uid();
    new.creado_en := now();
  else
    -- Firmado: solo se puede completar el PDF y el apunte, o anular
    if (to_jsonb(new) - array['pdf_ruta', 'movimiento_id', 'anulado', 'motivo_anulacion', 'actualizado_en'])
       is distinct from (to_jsonb(old) - array['pdf_ruta', 'movimiento_id', 'anulado', 'motivo_anulacion', 'actualizado_en'])
       or (old.pdf_ruta is not null and new.pdf_ruta is distinct from old.pdf_ruta)
       or (old.movimiento_id is not null and new.movimiento_id is distinct from old.movimiento_id)
       or (old.anulado and not new.anulado) then
      raise exception 'Un recibo firmado no se puede modificar. Si tiene un error, anúlalo y haz otro.' using errcode = 'check_violation';
    end if;
  end if;
  new.actualizado_en := now();
  return new;
end $$;
create trigger preparar_recibo before insert or update on public.recibos
  for each row execute function privado.preparar_recibo();
create trigger historial after insert or update or delete on public.recibos
  for each row execute function privado.registrar_historial();

-- El apunte de un recibo vigente no se anula desde el libro: se anula el recibo
create or replace function privado.proteger_recibo() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_codigo text;
begin
  if new.anulado and not old.anulado then
    select codigo into v_codigo from public.recibos where movimiento_id = new.id and not anulado and documento_id is null;
    if v_codigo is not null then
      raise exception 'Este apunte es el recibo %. Para anularlo, usa «Anular recibo».', v_codigo using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger proteger_recibo before update on public.movimientos
  for each row execute function privado.proteger_recibo();

-- Crear el recibo y su apunte en el libro en un solo paso
create or replace function public.crear_recibo(
  p_tipo text, p_fecha date, p_persona text, p_dni text, p_importe numeric, p_concepto text,
  p_cuenta uuid, p_categoria uuid, p_firma_persona text, p_firma_coral text, p_firmante_coral text, p_documento uuid default null
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare r public.recibos; d public.documentos; v_mov uuid;
begin
  if p_documento is not null then
    select * into d from public.documentos where id = p_documento;
    if not found or d.estado <> 'cobrada' then raise exception 'La factura no está cobrada.' using errcode = 'check_violation'; end if;
    if exists (select 1 from public.recibos where documento_id = d.id and not anulado) then
      raise exception 'Esta factura ya tiene recibo.' using errcode = 'check_violation';
    end if;
    insert into public.recibos (tipo, fecha, persona, dni, importe, concepto, documento_id, movimiento_id, firma_persona, firma_coral, firmante_coral)
    values ('cobro', p_fecha, p_persona, nullif(trim(p_dni), ''), d.total, p_concepto, d.id, d.movimiento_id, p_firma_persona, p_firma_coral, p_firmante_coral)
    returning * into r;
  else
    insert into public.recibos (tipo, fecha, persona, dni, importe, concepto, firma_persona, firma_coral, firmante_coral)
    values (p_tipo, p_fecha, p_persona, nullif(trim(p_dni), ''), p_importe, p_concepto, p_firma_persona, p_firma_coral, p_firmante_coral)
    returning * into r;
    insert into public.movimientos (tipo, fecha, importe, concepto, tercero, categoria_id, cuenta_id, notas)
    values (case p_tipo when 'pago' then 'gasto' else 'ingreso' end, p_fecha, p_importe, p_concepto, p_persona, p_categoria, p_cuenta,
            'Recibo ' || r.codigo)
    returning id into v_mov;
    update public.recibos set movimiento_id = v_mov where id = r.id returning * into r;
  end if;
  return jsonb_build_object('id', r.id, 'codigo', r.codigo, 'movimiento_id', r.movimiento_id, 'ejercicio', r.ejercicio);
end $$;

-- Anular un recibo (y su apunte, salvo que sea el cobro de una factura, que se gestiona en la factura)
create or replace function public.anular_recibo(p_recibo uuid, p_motivo text) returns void
language plpgsql security invoker set search_path = '' as $$
declare r public.recibos;
begin
  select * into r from public.recibos where id = p_recibo for update;
  if not found then raise exception 'No se encuentra el recibo.' using errcode = 'check_violation'; end if;
  if r.anulado then raise exception 'Este recibo ya está anulado.' using errcode = 'check_violation'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Indica el motivo de la anulación.' using errcode = 'check_violation'; end if;
  update public.recibos set anulado = true, motivo_anulacion = trim(p_motivo) where id = r.id;
  if r.documento_id is null and r.movimiento_id is not null then
    update public.movimientos set anulado = true, motivo_anulacion = 'Recibo ' || r.codigo || ' anulado: ' || trim(p_motivo)
      where id = r.movimiento_id and not anulado;
  end if;
end $$;

revoke execute on function public.crear_recibo(text, date, text, text, numeric, text, uuid, uuid, text, text, text, uuid),
  public.anular_recibo(uuid, text) from anon, public;
grant execute on function public.crear_recibo(text, date, text, text, numeric, text, uuid, uuid, text, text, text, uuid),
  public.anular_recibo(uuid, text) to authenticated;

alter table public.recibos enable row level security;
revoke all on public.recibos from anon;
create policy "ver" on public.recibos for select to authenticated using ((select privado.es_miembro()));
create policy "crear" on public.recibos for insert to authenticated with check ((select privado.puede_editar()));
create policy "editar" on public.recibos for update to authenticated
  using ((select privado.puede_editar())) with check ((select privado.puede_editar()));

-- El borrado de datos de prueba también vacía los recibos (y devuelve sus firmas para borrarlas del almacén)
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
    union all select firma_persona from public.recibos where firma_persona is not null
    union all select firma_coral from public.recibos where firma_coral is not null) t;
  delete from public.recibos where true;
  delete from public.documentos where tipo <> 'presupuesto';
  delete from public.documentos where true;
  delete from public.clientes where true;
  delete from public.justificantes where true;
  delete from public.conciliaciones where true;
  delete from public.movimientos where true;
  delete from public.historial where true;
  if p_empezar then
    update public.ajustes set modo_pruebas = false, en_uso_desde = current_date where id = 1;
  end if;
  return v_rutas;
end $$;
