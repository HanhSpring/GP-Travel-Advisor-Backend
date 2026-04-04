export class GetOrdersDto {
  placeId: string;
  status?: string = 'all';
  restaurant?: string = 'all';
  page?: number = 1;
  limit?: number = 10;
}