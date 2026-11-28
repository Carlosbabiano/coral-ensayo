-- Modo de pruebas: hasta «empezar de verdad», el administrador puede borrar todos los movimientos y documentos
-- para practicar. Se conservan usuarios, cuentas, categorías, logo y datos de la coral. Al empezar de verdad
-- el borrado queda desactivado para siempre.
alter table public.ajustes
  add column modo_pruebas boolean not null default true,
  add column en_uso_desde date;

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
  select coalesce(array_agg(ruta), '{}') into v_rutas from public.justificantes;
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
  return v_rutas;   -- la app borra después estos archivos del almacén
end $$;
revoke execute on function public.borrar_datos_prueba(boolean) from anon, public;
grant execute on function public.borrar_datos_prueba(boolean) to authenticated;

-- Nadie puede volver a activar el modo de pruebas desde la app una vez en uso real
create or replace function privado.proteger_modo_pruebas() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not old.modo_pruebas and new.modo_pruebas then
    raise exception 'La contabilidad ya está en uso real y no puede volver al modo de pruebas.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger proteger_modo_pruebas before update on public.ajustes
  for each row execute function privado.proteger_modo_pruebas();
