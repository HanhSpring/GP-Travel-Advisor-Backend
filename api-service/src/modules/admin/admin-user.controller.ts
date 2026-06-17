import {
  Controller,
  Get,
  Patch,
  Delete,
  HttpCode,
  HttpStatus,
  Query,
  Param,
  Body,
  Post,
  UseGuards,
 
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { GetUsersQueryDto } from './dto/get-users-query.dto';
import { BulkDeleteUsersDto } from './dto/bulk-delete.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateAdminDto } from './dto/admin-register.dto';
import { AdminService } from './admin.service';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from 'src/common/enum/role.enum';
import { UserActiveStatus } from './dto/get-users-query.dto';
import { CreateUserByAdminDto } from './dto/create-user-by-admin.dto';

@ApiTags('Admin - User Management')
@Controller('admin/users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
// @Roles(Role.Admin)
export class AdminUserController {
  constructor(private readonly adminService: AdminService) {}
  @Get('stats')
  @ApiOperation({ summary: 'Lấy 3 con số thống kê tổng quan của người dùng' })
  @ApiResponse({ status: 200, description: 'Trả về thống kê thành công' })
  getUserStats() {
    return this.adminService.getUserStats();
  }
  @Get()
  @ApiOperation({
    summary: 'Lấy danh sách người dùng (Hỗ trợ phân trang, tìm kiếm, lọc)',
  })
  @ApiResponse({
    status: 200,
    description: 'Trả về mảng danh sách và thông tin phân trang',
  })
  async getUsers(@Query() query: GetUsersQueryDto) {
    return this.adminService.getUsers(query);
  }
  @Delete('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Xóa hàng loạt người dùng (Bulk Soft Delete)' })
  @ApiResponse({
    status: 200,
    description: 'Đã xóa danh sách người dùng thành công',
  })
  bulkDeleteUsers(@Body() bulkDeleteDto: BulkDeleteUsersDto) {
    return this.adminService.bulkDeleteUsers(bulkDeleteDto.userIds);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Xóa một người dùng (Soft Delete)' })
  @ApiParam({ name: 'id', description: 'ID của người dùng cần xóa' })
  @ApiResponse({ status: 200, description: 'Đã xóa người dùng thành công' })
  deleteUser(@Param('id') id: string) {
    return this.adminService.deleteUser(id);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Khóa hoặc mở khóa tài khoản người dùng',
  })
  @ApiParam({
    name: 'id',
    description: 'ID của người dùng cần thay đổi trạng thái',
    example: 'uuid-1234',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['ACTIVE', 'LOCKED'],
          example: 'LOCKED',
          description: 'Trạng thái muốn áp dụng cho tài khoản',
        },
      },
      required: ['status'],
    },
  })
  async updateUserStatus(
    @Param('id') id: string,
    @Body('status') newStatus: UserActiveStatus,
  ) {
    return this.adminService.updateUserStatus(id, newStatus);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Lấy chi tiết thông tin của 1 người dùng cụ thể' })
  @ApiParam({
    name: 'id',
    description: 'ID của người dùng',
    example: 'uuid-1234',
  })
  @ApiResponse({
    status: 200,
    description: 'Trả về dữ liệu chi tiết để hiển thị lên Form',
  })
  async getUserDetail(@Param('id') id: string) {
    return this.adminService.getUserDetail(id);
  }

  @Post('admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Tạo tài khoản Admin mới' })
  @ApiBody({ type: CreateAdminDto })
  @ApiResponse({
    status: 201,
    description: 'Tạo tài khoản thành công.',
    schema: {
      example: {
        message: 'Tạo tài khoản Admin thành công',
        data: {
          id: 'd83b7008-608b-49ea-b184-25e227181057',
          role: 'ADMIN',
          email: 'admin.travelsystem@gmail.com',
          full_name: 'Trần Quản Trị',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Dữ liệu đầu vào không hợp lệ hoặc email đã tồn tại.',
  })
  async createAdmin(@Body() createAdminDto: CreateAdminDto) {
    return this.adminService.createAdmin(createAdminDto);
  }

  @Post()
  @ApiOperation({ summary: 'Admin tạo tài khoản người dùng mới' })
  @ApiResponse({ status: 201, description: 'Tạo tài khoản thành công' })
  @ApiResponse({
    status: 400,
    description: 'Lỗi validate dữ liệu hoặc email đã tồn tại',
  })
  createUser(@Body() createDto: CreateUserByAdminDto) {
    return this.adminService.createUserByAdmin(createDto);
  }
}
