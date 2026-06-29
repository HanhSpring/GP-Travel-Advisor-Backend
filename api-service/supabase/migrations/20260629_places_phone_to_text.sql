alter table travel.places
  alter column phone type text
  using case
    when phone is null then null
    else lpad(regexp_replace(phone::text, '\D', '', 'g'), 10, '0')
  end;

update travel.places
set phone = lpad(regexp_replace(phone, '\D', '', 'g'), 10, '0')
where phone is not null
  and phone ~ '^\d{1,9}$';
