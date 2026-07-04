alter table travel.places
  add column estimated_preparation_time integer null
  constraint places_estimated_preparation_time_check
  check (
    estimated_preparation_time is null
    or (estimated_preparation_time >= 1 and estimated_preparation_time <= 480)
  );

comment on column travel.places.estimated_preparation_time
  is 'Thời gian dự kiến hoàn thành đơn, đơn vị phút. Chỉ áp dụng cho địa điểm thuộc danh mục ẩm thực.';
