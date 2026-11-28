-- Años que se pueden elegir: cualquiera con apuntes, facturas, recibos, subvenciones o presupuesto anual
create or replace function public.ejercicios() returns setof int
language sql stable security invoker set search_path = '' as $$
  select distinct e from (
    select ejercicio as e from public.movimientos
    union select ejercicio from public.documentos
    union select ejercicio from public.recibos
    union select ejercicio from public.subvenciones
    union select ejercicio from public.presupuesto_lineas) t
  order by 1 desc
$$;
