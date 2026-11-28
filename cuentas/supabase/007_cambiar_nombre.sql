-- Cada persona puede corregir su propio nombre (el resto de su perfil, como el permiso, solo lo cambia el administrador)
create or replace function public.cambiar_mi_nombre(p_nombre text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or privado.mi_rol() is null then
    raise exception 'Tu usuario no tiene acceso.' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_nombre), '') = '' or length(trim(p_nombre)) > 80 then
    raise exception 'Escribe tu nombre (máximo 80 caracteres).' using errcode = 'check_violation';
  end if;
  update public.perfiles set nombre = trim(p_nombre) where id = auth.uid();
end $$;
revoke execute on function public.cambiar_mi_nombre(text) from anon, public;
grant execute on function public.cambiar_mi_nombre(text) to authenticated;
