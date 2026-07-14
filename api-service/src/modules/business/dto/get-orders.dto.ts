export class GetOrdersDto {
  placeId?: string;
  status?: string = 'all';
  restaurant?: string = 'all';
  page?: number | string = 1;
  limit?: number | string = 10;
}
