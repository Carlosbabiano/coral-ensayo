-- Contabilidad de la Coral Villa de Mengíbar · tanda 1: libro de ingresos y gastos, justificantes y tesorería.
-- Roles: admin (presidente: todo, incluidos usuarios), tesorero (apunta y edita), junta (solo consulta).
-- Nada se borra del libro: los apuntes se anulan. Todo cambio queda en «historial».

-- ---------- Funciones de permisos (en un esquema que la API no publica) ----------
create schema if not exists privado;
grant usage on schema privado to authenticated;

create table public.perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  nombre text not null,
  rol text not null check (rol in ('admin', 'tesorero', 'junta')),
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);

create or replace function privado.mi_rol() returns text
language sql stable security definer set search_path = '' as $$
  select rol from public.perfiles where id = auth.uid() and activo
$$;
create or replace function privado.es_miembro() returns boolean
language sql stable security definer set search_path = '' as $$
  select privado.mi_rol() is not null
$$;
create or replace function privado.puede_editar() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(privado.mi_rol() in ('admin', 'tesorero'), false)
$$;
grant execute on all functions in schema privado to authenticated;

-- ---------- Datos de la coral (una sola fila) ----------
create table public.ajustes (
  id int primary key default 1 check (id = 1),
  nombre text not null default 'Coral Villa de Mengíbar',
  cif text, direccion text, email text, telefono text, iban text,
  actualizado_en timestamptz not null default now()
);
insert into public.ajustes default values;

-- ---------- Cuentas de tesorería: caja y bancos ----------
create table public.cuentas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null check (length(trim(nombre)) > 0),
  tipo text not null check (tipo in ('caja', 'banco')),
  detalle text,                                   -- entidad y últimos dígitos, p. ej. «Caja Rural ···1234»
  saldo_inicial numeric(12,2) not null default 0, -- saldo en «fecha_inicial»; los apuntes anteriores no cuentan
  fecha_inicial date not null default current_date,
  activa boolean not null default true,
  orden int not null default 0,
  creado_en timestamptz not null default now()
);
insert into public.cuentas (nombre, tipo, orden) values ('Caja (efectivo)', 'caja', 0);

-- ---------- Categorías ----------
create table public.categorias (
  id uuid primary key default gen_random_uuid(),
  nombre text not null check (length(trim(nombre)) > 0),
  tipo text not null check (tipo in ('ingreso', 'gasto')),
  activa boolean not null default true,
  orden int not null default 0,
  unique (tipo, nombre)
);
insert into public.categorias (tipo, nombre, orden) values
  ('ingreso', 'Subvenciones públicas', 1),
  ('ingreso', 'Actuaciones: bodas', 2),
  ('ingreso', 'Actuaciones: otros eventos', 3),
  ('ingreso', 'Donativos y patrocinios', 4),
  ('ingreso', 'Cuotas de socios', 5),
  ('ingreso', 'Otros ingresos', 99),
  ('gasto', 'Dirección y músicos', 1),
  ('gasto', 'Partituras y material musical', 2),
  ('gasto', 'Desplazamientos y dietas', 3),
  ('gasto', 'Vestuario', 4),
  ('gasto', 'Local y alquileres', 5),
  ('gasto', 'Seguros', 6),
  ('gasto', 'Federaciones y cuotas', 7),
  ('gasto', 'Comidas y actos', 8),
  ('gasto', 'Gastos bancarios', 9),
  ('gasto', 'Otros gastos', 99);

-- ---------- Libro de ingresos y gastos ----------
create table public.movimientos (
  id uuid primary key default gen_random_uuid(),
  ejercicio int not null,
  numero int not null,
  fecha date not null,
  tipo text not null check (tipo in ('ingreso', 'gasto', 'traspaso')),
  concepto text not null check (length(trim(concepto)) > 0),
  tercero text,                                   -- a quién se paga o de quién se recibe
  categoria_id uuid references public.categorias(id),
  cuenta_id uuid not null references public.cuentas(id),
  cuenta_destino_id uuid references public.cuentas(id),
  importe numeric(12,2) not null check (importe > 0),
  notas text,
  conciliado boolean not null default false,
  anulado boolean not null default false,
  motivo_anulacion text,
  creado_por uuid references public.perfiles(id) default auth.uid(),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (ejercicio, numero),
  check ((tipo = 'traspaso') = (cuenta_destino_id is not null)),
  check (tipo = 'traspaso' or categoria_id is not null),
  check (cuenta_destino_id is null or cuenta_destino_id <> cuenta_id)
);
create index on public.movimientos (ejercicio, fecha desc);
create index on public.movimientos (cuenta_id);
create index on public.movimientos (cuenta_destino_id);
create index on public.movimientos (categoria_id);
create index on public.movimientos (creado_por);

-- Número correlativo por año, categoría del mismo tipo que el apunte y año fijo una vez creado
create or replace function privado.preparar_movimiento() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tipo_cat text;
begin
  if new.categoria_id is not null then
    select tipo into v_tipo_cat from public.categorias where id = new.categoria_id;
    if v_tipo_cat is distinct from new.tipo then
      raise exception 'La categoría no corresponde al tipo de apunte' using errcode = 'check_violation';
    end if;
  end if;
  if new.tipo = 'traspaso' then new.categoria_id := null; end if;

  if tg_op = 'INSERT' then
    new.ejercicio := extract(year from new.fecha)::int;
    perform pg_advisory_xact_lock(hashtext('movimientos-' || new.ejercicio));
    select coalesce(max(numero), 0) + 1 into new.numero from public.movimientos where ejercicio = new.ejercicio;
    new.creado_por := auth.uid();
    new.creado_en := now();
  else
    if extract(year from new.fecha)::int <> old.ejercicio then
      raise exception 'Un apunte no puede cambiar de año: anúlalo y crea uno nuevo en el año correcto'
        using errcode = 'check_violation';
    end if;
    new.ejercicio := old.ejercicio;
    new.numero := old.numero;
    new.creado_por := old.creado_por;
    new.creado_en := old.creado_en;
  end if;
  new.actualizado_en := now();
  return new;
end $$;
create trigger preparar_movimiento before insert or update on public.movimientos
  for each row execute function privado.preparar_movimiento();

-- ---------- Justificantes (los archivos van al almacén «justificantes») ----------
create table public.justificantes (
  id uuid primary key default gen_random_uuid(),
  movimiento_id uuid not null references public.movimientos(id) on delete cascade,
  ruta text not null unique,
  nombre text not null,
  tipo_mime text,
  tamano int,
  subido_por uuid references public.perfiles(id) default auth.uid(),
  subido_en timestamptz not null default now()
);
create index on public.justificantes (movimiento_id);
create index on public.justificantes (subido_por);

-- ---------- Cuadres con el extracto del banco ----------
create table public.conciliaciones (
  id uuid primary key default gen_random_uuid(),
  cuenta_id uuid not null references public.cuentas(id),
  fecha date not null,
  saldo_extracto numeric(12,2) not null,
  saldo_app numeric(12,2) not null,
  notas text,
  creado_por uuid references public.perfiles(id) default auth.uid(),
  creado_en timestamptz not null default now()
);
create index on public.conciliaciones (cuenta_id, fecha desc);
create index on public.conciliaciones (creado_por);

-- ---------- Saldos ----------
create view public.saldos_cuentas with (security_invoker = true) as
select c.id, c.nombre, c.tipo, c.detalle, c.activa, c.orden, c.saldo_inicial, c.fecha_inicial,
  c.saldo_inicial + coalesce(sum(case
    when m.cuenta_id = c.id and m.tipo = 'ingreso' then m.importe
    when m.cuenta_id = c.id then -m.importe                       -- gasto o traspaso que sale
    when m.cuenta_destino_id = c.id then m.importe                -- traspaso que entra
  end), 0)::numeric(12,2) as saldo,
  count(m.id) filter (where not m.conciliado) as sin_conciliar
from public.cuentas c
left join public.movimientos m
  on (m.cuenta_id = c.id or m.cuenta_destino_id = c.id) and not m.anulado and m.fecha >= c.fecha_inicial
group by c.id;

create or replace function public.saldo_a_fecha(p_cuenta uuid, p_fecha date) returns numeric
language sql stable security invoker set search_path = '' as $$
  select (c.saldo_inicial + coalesce(sum(case
      when m.cuenta_id = c.id and m.tipo = 'ingreso' then m.importe
      when m.cuenta_id = c.id then -m.importe
      when m.cuenta_destino_id = c.id then m.importe
    end), 0))::numeric(12,2)
  from public.cuentas c
  left join public.movimientos m
    on (m.cuenta_id = c.id or m.cuenta_destino_id = c.id) and not m.anulado
       and m.fecha >= c.fecha_inicial and m.fecha <= p_fecha
  where c.id = p_cuenta
  group by c.id
$$;

create or replace function public.ejercicios() returns setof int
language sql stable security invoker set search_path = '' as $$
  select distinct ejercicio from public.movimientos order by 1 desc
$$;

-- Lo usa la tarea automática que evita que el proyecto gratuito se pause por inactividad
create or replace function public.latido() returns timestamptz
language sql stable set search_path = '' as $$ select now() $$;

-- ---------- Historial de cambios ----------
create table public.historial (
  id bigint generated always as identity primary key,
  tabla text not null,
  registro_id text,
  accion text not null,
  antes jsonb,
  despues jsonb,
  usuario uuid,
  usuario_nombre text,
  en timestamptz not null default now()
);
create index on public.historial (en desc);
create index on public.historial (tabla, registro_id);

create or replace function privado.registrar_historial() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_nombre text;
begin
  select nombre into v_nombre from public.perfiles where id = auth.uid();
  if tg_op = 'INSERT' then
    insert into public.historial (tabla, registro_id, accion, despues, usuario, usuario_nombre)
    values (tg_table_name, new.id::text, 'alta', to_jsonb(new), auth.uid(), v_nombre);
    return new;
  elsif tg_op = 'UPDATE' then
    if to_jsonb(new) - 'actualizado_en' = to_jsonb(old) - 'actualizado_en' then return new; end if;
    insert into public.historial (tabla, registro_id, accion, antes, despues, usuario, usuario_nombre)
    values (tg_table_name, new.id::text, 'cambio', to_jsonb(old), to_jsonb(new), auth.uid(), v_nombre);
    return new;
  else
    insert into public.historial (tabla, registro_id, accion, antes, usuario, usuario_nombre)
    values (tg_table_name, old.id::text, 'baja', to_jsonb(old), auth.uid(), v_nombre);
    return old;
  end if;
end $$;

create trigger historial after insert or update or delete on public.movimientos
  for each row execute function privado.registrar_historial();
create trigger historial after insert or update or delete on public.justificantes
  for each row execute function privado.registrar_historial();
create trigger historial after insert or update or delete on public.cuentas
  for each row execute function privado.registrar_historial();
create trigger historial after insert or update or delete on public.categorias
  for each row execute function privado.registrar_historial();
create trigger historial after insert or update or delete on public.conciliaciones
  for each row execute function privado.registrar_historial();
create trigger historial after update on public.ajustes
  for each row execute function privado.registrar_historial();
create trigger historial after insert or update or delete on public.perfiles
  for each row execute function privado.registrar_historial();

-- ---------- Seguridad: solo miembros activos ven; solo admin y tesorero escriben ----------
alter table public.perfiles enable row level security;
alter table public.ajustes enable row level security;
alter table public.cuentas enable row level security;
alter table public.categorias enable row level security;
alter table public.movimientos enable row level security;
alter table public.justificantes enable row level security;
alter table public.conciliaciones enable row level security;
alter table public.historial enable row level security;

revoke all on all tables in schema public from anon;
revoke execute on function public.saldo_a_fecha(uuid, date), public.ejercicios() from anon, public;
grant execute on function public.saldo_a_fecha(uuid, date), public.ejercicios() to authenticated;
grant execute on function public.latido() to anon, authenticated;

create policy "ver perfiles" on public.perfiles for select to authenticated
  using (id = (select auth.uid()) or (select privado.es_miembro()));
-- Los perfiles solo los cambia la función «usuarios» (con permisos de servidor), nunca la app directamente

create policy "ver" on public.ajustes for select to authenticated using ((select privado.es_miembro()));
create policy "editar" on public.ajustes for update to authenticated
  using ((select privado.puede_editar())) with check ((select privado.puede_editar()));

create policy "ver" on public.cuentas for select to authenticated using ((select privado.es_miembro()));
create policy "crear" on public.cuentas for insert to authenticated with check ((select privado.puede_editar()));
create policy "editar" on public.cuentas for update to authenticated
  using ((select privado.puede_editar())) with check ((select privado.puede_editar()));

create policy "ver" on public.categorias for select to authenticated using ((select privado.es_miembro()));
create policy "crear" on public.categorias for insert to authenticated with check ((select privado.puede_editar()));
create policy "editar" on public.categorias for update to authenticated
  using ((select privado.puede_editar())) with check ((select privado.puede_editar()));

create policy "ver" on public.movimientos for select to authenticated using ((select privado.es_miembro()));
create policy "crear" on public.movimientos for insert to authenticated with check ((select privado.puede_editar()));
create policy "editar" on public.movimientos for update to authenticated
  using ((select privado.puede_editar())) with check ((select privado.puede_editar()));

create policy "ver" on public.justificantes for select to authenticated using ((select privado.es_miembro()));
create policy "crear" on public.justificantes for insert to authenticated with check ((select privado.puede_editar()));
create policy "quitar" on public.justificantes for delete to authenticated using ((select privado.puede_editar()));

create policy "ver" on public.conciliaciones for select to authenticated using ((select privado.es_miembro()));
create policy "crear" on public.conciliaciones for insert to authenticated with check ((select privado.puede_editar()));

create policy "ver" on public.historial for select to authenticated using ((select privado.es_miembro()));

-- ---------- Almacén privado de justificantes (fotos y PDF, máx. 10 MB) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('justificantes', 'justificantes', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

create policy "justificantes: ver" on storage.objects for select to authenticated
  using (bucket_id = 'justificantes' and (select privado.es_miembro()));
create policy "justificantes: subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'justificantes' and (select privado.puede_editar()));
create policy "justificantes: quitar" on storage.objects for delete to authenticated
  using (bucket_id = 'justificantes' and (select privado.puede_editar()));
