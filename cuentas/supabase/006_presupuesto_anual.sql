-- Presupuesto anual por categorías (lo aprueba la asamblea con la memoria del año anterior)
create table public.presupuesto_lineas (
  ejercicio int not null check (ejercicio between 2000 and 2100),
  categoria_id uuid not null references public.categorias(id),
  importe numeric(12,2) not null check (importe >= 0),
  actualizado_en timestamptz not null default now(),
  primary key (ejercicio, categoria_id)
);
create index on public.presupuesto_lineas (categoria_id);

alter table public.presupuesto_lineas enable row level security;
revoke all on public.presupuesto_lineas from anon;
create policy "ver" on public.presupuesto_lineas for select to authenticated using ((select privado.es_miembro()));
create policy "crear" on public.presupuesto_lineas for insert to authenticated with check ((select privado.puede_editar()));
create policy "editar" on public.presupuesto_lineas for update to authenticated using ((select privado.puede_editar())) with check ((select privado.puede_editar()));
create policy "quitar" on public.presupuesto_lineas for delete to authenticated using ((select privado.puede_editar()));

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
  delete from public.presupuesto_lineas where true;
  delete from public.historial where true;
  if p_empezar then
    update public.ajustes set modo_pruebas = false, en_uso_desde = current_date where id = 1;
  end if;
  return v_rutas;
end $$;
