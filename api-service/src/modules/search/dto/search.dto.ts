import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SearchQueryDto {
  @ApiProperty({ example: 'ha noi' })
  @IsString()
  q: string;
}
