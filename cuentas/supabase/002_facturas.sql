-- Contabilidad de la coral · tanda 2: clientes, presupuestos y facturas.
-- Presupuestos: se editan mientras no estén facturados. Facturas y rectificativas: numeración correlativa por año,
-- y una vez emitidas no se cambia su contenido (solo el estado de cobro). Los totales los calcula la base de datos.

-- ---------- Ajustes nuevos ----------
alter table public.ajustes
  add column logo_ruta text,
  add column iva_pct numeric(5,2) not null default 0,
  add column iva_texto text default 'Operación exenta de IVA (art. 20.Uno.14 de la Ley 37/1992). Pendiente de confirmar con la gestoría.',
  add column pie_documentos text,
  add column validez_dias int not null default 30 check (validez_dias between 1 and 365),
  add column conceptos_frecuentes text default E'Actuación del coro en la ceremonia\nEnsayo con los novios\nDesplazamiento';

-- ---------- Clientes ----------
create table public.clientes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null check (length(trim(nombre)) > 0),
  nif text, direccion text, email text, telefono text, notas text,
  creado_en timestamptz not null default now()
);
create index on public.clientes (lower(nombre));

-- ---------- Presupuestos, facturas y rectificativas ----------
create table public.documentos (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('presupuesto', 'factura', 'rectificativa')),
  ejercicio int not null,
  numero int not null,
  codigo text not null,
  fecha date not null,
  cliente_id uuid references public.clientes(id),
  cliente jsonb not null,                        -- copia de los datos del cliente al emitir (no cambia si luego se edita el cliente)
  lineas jsonb not null check (jsonb_typeof(lineas) = 'array' and jsonb_array_length(lineas) > 0),
  iva_pct numeric(5,2) not null default 0 check (iva_pct >= 0 and iva_pct <= 100),
  iva_texto text,
  base numeric(12,2) not null default 0,
  iva_importe numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  notas text,
  validez_hasta date,
  estado text not null,
  presupuesto_id uuid references public.documentos(id),
  rectifica_id uuid references public.documentos(id),
  movimiento_id uuid references public.movimientos(id),
  cobrada_en date,
  creado_por uuid references public.perfiles(id) default auth.uid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (tipo, ejercicio, numero),
  check (
    (tipo = 'presupuesto' and estado in ('borrador', 'enviado', 'aceptado', 'rechazado', 'facturado')) or
    (tipo = 'factura' and estado in ('emitida', 'cobrada', 'rectificada')) or
    (tipo = 'rectificativa' and estado = 'emitida' and rectifica_id is not null))
);
create index on public.documentos (tipo, ejercicio, numero desc);
create index on public.documentos (cliente_id);
create index on public.documentos (movimiento_id);
create index on public.documentos (presupuesto_id);
create index on public.documentos (rectifica_id);
create index on public.documentos (creado_por);

create or replace function privado.preparar_documento() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_base numeric := 0; l jsonb;
begin
  if tg_op = 'UPDATE' and old.tipo <> 'presupuesto' then
    -- Factura emitida: solo puede cambiar su estado de cobro
    if (to_jsonb(new) - array['estado', 'movimiento_id', 'cobrada_en', 'actualizado_en'])
       is distinct from (to_jsonb(old) - array['estado', 'movimiento_id', 'cobrada_en', 'actualizado_en']) then
      raise exception 'Una factura emitida no se puede modificar. Si tiene un error, haz una factura rectificativa.'
        using errcode = 'check_violation';
    end if;
    new.actualizado_en := now();
    return new;
  end if;
  if tg_op = 'UPDATE' and old.estado = 'facturado'
     and (to_jsonb(new) - 'actualizado_en') is distinct from (to_jsonb(old) - 'actualizado_en') then
    raise exception 'Este presupuesto ya se ha convertido en factura y no se puede cambiar.' using errcode = 'check_violation';
  end if;

  -- Totales calculados aquí, nunca en la app
  for l in select * from jsonb_array_elements(new.lineas) loop
    if coalesce(trim(l->>'concepto'), '') = '' then
      raise exception 'Cada línea necesita un concepto.' using errcode = 'check_violation';
    end if;
    v_base := v_base + round((l->>'cantidad')::numeric * (l->>'precio')::numeric, 2);
  end loop;
  new.base := v_base;
  new.iva_importe := round(v_base * new.iva_pct / 100, 2);
  new.total := new.base + new.iva_importe;
  if new.tipo <> 'rectificativa' and new.total <= 0 then
    raise exception 'El total tiene que ser mayor que cero.' using errcode = 'check_violation';
  end if;
  if coalesce(trim(new.cliente->>'nombre'), '') = '' then
    raise exception 'Falta el nombre del cliente.' using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    new.ejercicio := extract(year from new.fecha)::int;
    perform pg_advisory_xact_lock(hashtext('documentos-' || new.tipo || '-' || new.ejercicio));
    select coalesce(max(numero), 0) + 1 into new.numero from public.documentos
      where tipo = new.tipo and ejercicio = new.ejercicio;
    new.codigo := case new.tipo when 'presupuesto' then 'P' when 'factura' then 'F' else 'R' end
                  || '-' || new.ejercicio || '-' || lpad(new.numero::text, 3, '0');
    new.creado_por := auth.uid();
    new.creado_en := now();
  else
    if extract(year from new.fecha)::int <> old.ejercicio then
      raise exception 'Un presupuesto no puede cambiar de año: duplícalo con la fecha nueva.' using errcode = 'check_violation';
    end if;
    new.ejercicio := old.ejercicio; new.numero := old.numero; new.codigo := old.codigo; new.tipo := old.tipo;
    new.creado_por := old.creado_por; new.creado_en := old.creado_en;
  end if;
  new.actualizado_en := now();
  return new;
end $$;
create trigger preparar_documento before insert or update on public.documentos
  for each row execute function privado.preparar_documento();

-- Las facturas no se pueden emitir con fecha anterior a la última del año (la ley pide orden correlativo)
create or replace function privado.fecha_factura_ordenada() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ultima date;
begin
  if new.tipo = 'presupuesto' then return new; end if;
  select max(fecha) into v_ultima from public.documentos
    where tipo = new.tipo and ejercicio = extract(year from new.fecha)::int and id <> new.id;
  if v_ultima is not null and new.fecha < v_ultima then
    raise exception 'La fecha no puede ser anterior a la de la última factura (%). Las facturas deben ir en orden.', to_char(v_ultima, 'DD/MM/YYYY')
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger fecha_factura_ordenada before insert on public.documentos
  for each row execute function privado.fecha_factura_ordenada();

create trigger historial after insert or update or delete on public.clientes
  for each row execute function privado.registrar_historial();
create trigger historial after insert or update or delete on public.documentos
  for each row execute function privado.registrar_historial();

-- ---------- Operaciones en un solo paso ----------
-- Convertir un presupuesto en factura
create or replace function public.convertir_presupuesto(p_presupuesto uuid, p_fecha date) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare p public.documentos; v_id uuid;
begin
  select * into p from public.documentos where id = p_presupuesto and tipo = 'presupuesto' for update;
  if not found then raise exception 'No se encuentra el presupuesto.' using errcode = 'check_violation'; end if;
  if p.estado = 'facturado' then raise exception 'Este presupuesto ya está facturado.' using errcode = 'check_violation'; end if;
  insert into public.documentos (tipo, fecha, cliente_id, cliente, lineas, iva_pct, iva_texto, notas, estado, presupuesto_id)
  values ('factura', p_fecha, p.cliente_id, p.cliente, p.lineas, p.iva_pct, p.iva_texto, p.notas, 'emitida', p.id)
  returning id into v_id;
  update public.documentos set estado = 'facturado' where id = p.id;
  return v_id;
end $$;

-- Registrar el cobro: crea el ingreso en el libro y marca la factura como cobrada
create or replace function public.cobrar_factura(p_factura uuid, p_cuenta uuid, p_fecha date, p_categoria uuid) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare f public.documentos; v_mov uuid;
begin
  select * into f from public.documentos where id = p_factura for update;
  if not found or f.tipo <> 'factura' then raise exception 'No se encuentra la factura.' using errcode = 'check_violation'; end if;
  if f.estado <> 'emitida' then raise exception 'Esta factura ya está cobrada o rectificada.' using errcode = 'check_violation'; end if;
  insert into public.movimientos (tipo, fecha, importe, concepto, tercero, categoria_id, cuenta_id, notas)
  values ('ingreso', p_fecha, f.total, 'Cobro factura ' || f.codigo, f.cliente->>'nombre', p_categoria, p_cuenta, null)
  returning id into v_mov;
  update public.documentos set estado = 'cobrada', movimiento_id = v_mov, cobrada_en = p_fecha where id = f.id;
  return v_mov;
end $$;

-- Deshacer un cobro registrado por error: anula el ingreso y la factura vuelve a «emitida»
create or replace function public.deshacer_cobro(p_factura uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare f public.documentos;
begin
  select * into f from public.documentos where id = p_factura for update;
  if not found or f.estado <> 'cobrada' then raise exception 'Esta factura no está cobrada.' using errcode = 'check_violation'; end if;
  update public.documentos set estado = 'emitida', movimiento_id = null, cobrada_en = null where id = f.id;
  update public.movimientos set anulado = true, motivo_anulacion = 'Cobro deshecho de la factura ' || f.codigo where id = f.movimiento_id;
end $$;

-- Factura rectificativa: copia la factura con importes en negativo y deja la original como «rectificada»
create or replace function public.rectificar_factura(p_factura uuid, p_fecha date, p_motivo text) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare f public.documentos; v_id uuid; v_lineas jsonb;
begin
  select * into f from public.documentos where id = p_factura for update;
  if not found or f.tipo <> 'factura' then raise exception 'No se encuentra la factura.' using errcode = 'check_violation'; end if;
  if f.estado = 'rectificada' then raise exception 'Esta factura ya está rectificada.' using errcode = 'check_violation'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Indica el motivo de la rectificación.' using errcode = 'check_violation'; end if;
  select jsonb_agg(l || jsonb_build_object('cantidad', -((l->>'cantidad')::numeric))) into v_lineas
    from jsonb_array_elements(f.lineas) l;
  insert into public.documentos (tipo, fecha, cliente_id, cliente, lineas, iva_pct, iva_texto, notas, estado, rectifica_id)
  values ('rectificativa', p_fecha, f.cliente_id, f.cliente, v_lineas, f.iva_pct, f.iva_texto,
          'Rectifica la factura ' || f.codigo || ' del ' || to_char(f.fecha, 'DD/MM/YYYY') || '. Motivo: ' || trim(p_motivo), 'emitida', f.id)
  returning id into v_id;
  update public.documentos set estado = 'rectificada' where id = f.id;
  return v_id;
end $$;

-- El ingreso de una factura cobrada no se anula desde el libro: hay que «deshacer el cobro» en la factura
create or replace function privado.proteger_cobro() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_codigo text;
begin
  if new.anulado and not old.anulado then
    select codigo into v_codigo from public.documentos where movimiento_id = new.id;
    if v_codigo is not null then
      raise exception 'Este ingreso es el cobro de la factura %. Para anularlo, usa «Deshacer cobro» en la factura.', v_codigo
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger proteger_cobro before update on public.movimientos
  for each row execute function privado.proteger_cobro();

revoke execute on function public.convertir_presupuesto(uuid, date), public.cobrar_factura(uuid, uuid, date, uuid),
  public.deshacer_cobro(uuid), public.rectificar_factura(uuid, date, text) from anon, public;
grant execute on function public.convertir_presupuesto(uuid, date), public.cobrar_factura(uuid, uuid, date, uuid),
  public.deshacer_cobro(uuid), public.rectificar_factura(uuid, date, text) to authenticated;

-- ---------- Seguridad ----------
alter table public.clientes enable row level security;
alter table public.documentos enable row level security;
revoke all on public.clientes, public.documentos from anon;

create policy "ver" on public.clientes for select to authenticated using ((select privado.es_miembro()));
create policy "crear" on public.clientes for insert to authenticated with check ((select privado.puede_editar()));
create policy "editar" on public.clientes for update to authenticated
  using ((select privado.puede_editar())) with check ((select privado.puede_editar()));

create policy "ver" on public.documentos for select to authenticated using ((select privado.es_miembro()));
create policy "crear" on public.documentos for insert to authenticated with check ((select privado.puede_editar()));
create policy "editar" on public.documentos for update to authenticated
  using ((select privado.puede_editar())) with check ((select privado.puede_editar()));
-- Solo se pueden borrar presupuestos en borrador (las facturas nunca)
create policy "borrar borradores" on public.documentos for delete to authenticated
  using ((select privado.puede_editar()) and tipo = 'presupuesto' and estado = 'borrador');
