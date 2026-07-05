// cities.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { CitiesService } from './city.service';
import { GetCitiesQueryDto } from './dto/get-cities-query.dto';
import { City } from './entity/city.entity';

@ApiTags('Cities')
@Controller('cities')
export class CitiesController {
  constructor(private readonly citiesService: CitiesService) {}

  @Get()
  @ApiOperation({
    summary: 'Lấy danh sách hoặc tìm kiếm thành phố',
    description:
      'Trả về danh sách các thành phố. Truyền thêm query "search" để tìm kiếm theo tên. ' +
      'Điểm khởi hành có thể tìm trên toàn bộ thành phố; điểm đến cần truyền "destinationOnly=true" ' +
      'để chỉ nhận về các tỉnh/thành mà app đang hỗ trợ lên lịch trình.',
  })
  @ApiOkResponse({
    description: 'Lấy danh sách thành phố thành công.',
    type: [City],
  })
  async getCities(@Query() query: GetCitiesQueryDto): Promise<City[]> {
    return this.citiesService.findAll(query.search, query.destinationOnly);
  }
}
