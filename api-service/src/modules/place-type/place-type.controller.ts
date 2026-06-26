import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlaceType } from './entity/place-type.entity';
import { PlaceTypesService } from './place-type.service';

@ApiTags('Types')
@Controller('types')
export class PlaceTypesController {
  constructor(private readonly placeTypesService: PlaceTypesService) {}

  @Get()
  @ApiOperation({
    summary: 'Lấy danh sách hoặc tìm kiếm loại hình kinh doanh',
    description: 'Trả về danh sách loại hình kinh doanh từ bảng travel.types.',
  })
  @ApiOkResponse({
    description: 'Lấy danh sách loại hình kinh doanh thành công.',
    type: [PlaceType],
  })
  async getTypes(@Query('search') search?: string): Promise<PlaceType[]> {
    return this.placeTypesService.findAll(search);
  }
}
