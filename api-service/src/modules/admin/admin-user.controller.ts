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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { GetUsersQueryDto } from './dto/get-users-query.dto';
import { BulkDeleteUsersDto } from './dto/bulk-delete.dto';
import { UpdateUserByAdminDto } from './dto/update-user-by-admin.dto';

@ApiTags('Admin - User Management')
@Controller('admin/users')
// @UseGuards(JwtAuthGuard, RolesGuard) -> Sau này nhớ bật guard để chặn người lạ gọi API này
// @Roles(Role.Admin)
export class AdminUserController {
  @Get('stats')
  @ApiOperation({ summary: 'Lấy các con số thống kê tổng quan (Top Cards)' })
  getStats() {
    return {
      totalUsers: 12450,
      newThisMonth: 124,
      totalAdmins: 8,
    };
  }

  @Get()
  @ApiOperation({
    summary: 'Lấy danh sách người dùng (Hỗ trợ phân trang, tìm kiếm, lọc)',
  })
  @ApiResponse({
    status: 200,
    description: 'Trả về mảng danh sách và thông tin phân trang',
  })
  getUsers(@Query() query: GetUsersQueryDto) {
    // Dùng @Query() thay vì @Body()
    // Data mẫu trả về cho Frontend dựng bảng
    return {
      data: [
        {
          id: 'uuid-1',
          fullName: 'Tran Thi B',
          email: 'b.tran@hotel.com',
          role: 'BUSINESS',
          status: 'ACTIVE',
          joinedDate: '2023-03-15',
        },
        // ... các user khác
      ],
      meta: {
        totalItems: 120, // Tổng số dòng trong Database thỏa mãn điều kiện lọc
        itemCount: 10, // Số dòng trả về ở trang hiện tại
        itemsPerPage: query.limit,
        totalPages: 12, // Tổng số trang (120 / 10 = 12)
        currentPage: query.page,
      },
    };
  }

  // API xử lý nút icon Thùng rác (Xóa 1 user)
  @Delete(':id')
  @ApiOperation({ summary: 'Xóa một người dùng (Soft Delete)' })
  @ApiParam({ name: 'id', description: 'ID của người dùng cần xóa' })
  @ApiResponse({ status: 200, description: 'Đã xóa người dùng thành công' })
  deleteUser(@Param('id') id: string) {
    return {
      message: `Đã xóa thành công người dùng có ID: ${id}`,
      success: true,
    };
  }

  // API xử lý khi chọn nhiều Checkbox (Xóa nhiều user)
  @Delete('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Xóa hàng loạt người dùng (Bulk Soft Delete)' })
  @ApiResponse({
    status: 200,
    description: 'Đã xóa danh sách người dùng thành công',
  })
  bulkDeleteUsers(@Body() bulkDeleteDto: BulkDeleteUsersDto) {
    return {
      message: `Đã xóa thành công ${bulkDeleteDto.userIds.length} người dùng`,
      success: true,
    };
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Khóa hoặc mở khóa tài khoản người dùng ở trang CT thông tin user',
  })
  @ApiParam({
    name: 'id',
    description: 'ID của người dùng cần thay đổi trạng thái',
  })
  toggleStatus(
    @Param('id') id: string,
    @Body('status') newStatus: 'ACTIVE' | 'LOCKED',
  ) {
    return {
      message: `Đã thay đổi trạng thái của user ${id} thành ${newStatus}`,
      success: true,
    };
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
  getUserDetail(@Param('id') id: string) {
    // Dữ liệu mẫu (Mock data) khớp với giao diện
    return {
      id: id,
      fullName: 'Nguyen Admin',
      email: 'admin@system.com',
      phoneNumber: '0987654321',
      dateOfBirth: '1990-01-01',
      address: '123 Đường Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP. HCM',
      role: 'ADMIN',
      status: 'ACTIVE', // Để FE biết đường hiển thị nút "Khóa" hay "Mở khóa"
    };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin cập nhật thông tin cá nhân và vai trò của người dùng',
  })
  @ApiParam({ name: 'id', description: 'ID của người dùng cần cập nhật' })
  @ApiResponse({ status: 200, description: 'Cập nhật thành công' })
  updateUserDetail(
    @Param('id') id: string,
    @Body() updateDto: UpdateUserByAdminDto,
  ) {
    // Logic BE sẽ cập nhật vào database dựa trên id
    return {
      message: 'Lưu thay đổi thành công',
      updatedData: updateDto,
    };
  }
}
