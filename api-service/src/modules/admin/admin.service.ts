import {
  Injectable,
  InternalServerErrorException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CreateAdminDto } from './dto/admin-register.dto';
import {
  GetUsersQueryDto,
  UserActiveStatus,
  UserDeleteStatus,
} from './dto/get-users-query.dto';
import { CreateUserByAdminDto } from './dto/create-user-by-admin.dto';
import { UploadService } from '../upload/upload.service';

@Injectable()
export class AdminService {
  private supabase: SupabaseClient;
  constructor(private readonly uploadService: UploadService) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase URL or Anon Key');
    }
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  async createAdmin(createAdminDto: CreateAdminDto) {
    const { email, password, full_name, phone_number, avatar_url } =
      createAdminDto;

    const { data, error } = await this.supabase.auth.signUp({
      email: email,
      password: password,
      options: {
        data: {
          full_name: full_name,
          phone_number: phone_number,
          avatar_url: avatar_url,
          role: 'ADMIN',
        },
      },
    });

    if (error) {
      throw new BadRequestException(`Đăng ký Admin thất bại: ${error.message}`);
    }

    return {
      message: 'Tạo tài khoản Admin thành công.',
      user: {
        id: data.user?.id,
        email: data.user?.email,
      },
    };
  }
  async getUsers(queryDto: GetUsersQueryDto) {
    const {
      page = 1,
      limit = 10,
      search = null,
      role = null,
      activeStatus = null,
      deleteStatus = null,
    } = queryDto;

    let bitStatus: string | null = null;
    if (activeStatus === UserActiveStatus.ACTIVE) bitStatus = '1';
    else if (activeStatus === UserActiveStatus.LOCKED) bitStatus = '0';

    let bitDeleteStatus: string | null = null;
    if (deleteStatus === UserDeleteStatus.DELETED) bitDeleteStatus = '1';
    else if (deleteStatus === UserDeleteStatus.UNDELETED) bitDeleteStatus = '0';

    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_KEY as string,
    );

    const { data, error } = await supabaseAdmin.rpc('get_users_list', {
      page_number: page,
      page_size: limit,
      search_text: search,
      filter_role: role,
      filter_is_active: bitStatus,
      filter_is_deleted: bitDeleteStatus,
    });
    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi lấy danh sách user: ${error.message}`,
      );
    }

    const totalItems =
      data && data.length > 0 ? Number(data[0].total_count) : 0;
    const totalPages = Math.ceil(totalItems / limit);

    return {
      data: (data || []).map((user: any) => ({
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: user.role,
        activeStatus:
          user.is_active === '1'
            ? UserActiveStatus.ACTIVE
            : UserActiveStatus.LOCKED,
        deleteStatus:
          user.is_deleted === '1'
            ? UserDeleteStatus.DELETED
            : UserDeleteStatus.UNDELETED,
        avatarUrl: user.avatar_url,
        joinedDate: user.created_at,
      })),
      meta: {
        totalItems: totalItems,
        itemCount: data?.length || 0,
        itemsPerPage: limit,
        totalPages: totalPages,
        currentPage: page,
      },
    };
  }

  async getUserDetail(id: string) {
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_KEY as string,
    );

    const { data, error } = await supabaseAdmin.rpc(
      'get_user_detail_by_admin',
      {
        p_user_id: id,
      },
    );

    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi lấy chi tiết người dùng: ${error.message}`,
      );
    }

    if (!data || data.length === 0) {
      throw new NotFoundException(
        'Không tìm thấy thông tin người dùng trong hệ thống',
      );
    }

    const user = data[0];
    return {
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      phoneNumber: user.phone_number,
      dateOfBirth: user.date_of_birth,
      address: user.address,
      role: user.role,
      activeStatus:
        user.is_active === '1'
          ? UserActiveStatus.ACTIVE
          : UserActiveStatus.LOCKED,
      deleteStatus:
        user.is_deleted === '1'
          ? UserDeleteStatus.DELETED
          : UserDeleteStatus.UNDELETED,
      avatarUrl: user.avatar_url,
    };
  }
  async updateUserStatus(id: string, newStatus: UserActiveStatus) {
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_KEY as string,
    );
    const bitStatus = newStatus === UserActiveStatus.ACTIVE ? '1' : '0';

    const { error } = await supabaseAdmin.rpc('update_user_active_status', {
      p_user_id: id,
      p_is_active: bitStatus,
    });

    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi cập nhật trạng thái: ${error.message}`,
      );
    }

    const statusText =
      newStatus === UserActiveStatus.ACTIVE ? 'Hoạt động' : 'Đã khóa';
    return {
      success: true,
      message: `Đã cập nhật trạng thái người dùng thành ${statusText}.`,
    };
  }
  async bulkDeleteUsers(userIds: string[]) {
    if (!userIds || userIds.length === 0) {
      throw new BadRequestException('Danh sách ID người dùng trống');
    }

    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_KEY as string,
    );

    const { data: deletedCount, error } = await supabaseAdmin.rpc(
      'soft_delete_users',
      {
        p_user_ids: userIds,
      },
    );

    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi xóa người dùng: ${error.message}`,
      );
    }

    if (deletedCount === 0) {
      throw new NotFoundException(
        'Không tìm thấy người dùng nào hợp lệ để xóa',
      );
    }

    return {
      success: true,
      message: `Đã xóa thành công ${deletedCount} người dùng.`,
      deletedCount,
    };
  }

  async deleteUser(id: string) {
    return this.bulkDeleteUsers([id]);
  }
  async createUserByAdmin(createDto: CreateUserByAdminDto) {
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_KEY as string,
    );

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: createDto.email,
      password: createDto.password,
      email_confirm: true,
      user_metadata: {
        full_name: createDto.fullName,
        phone_number: createDto.phoneNumber,
        role: createDto.role,
        status: createDto.status,
        avatar_url: createDto.avatarUrl,
      },
    });

    if (error) {
      throw new BadRequestException(
        `Không thể tạo người dùng: ${error.message}`,
      );
    }

    return {
      success: true,
      message: 'Tạo tài khoản người dùng thành công',
      user: {
        id: data.user.id,
        email: data.user.email,
        role: createDto.role,
      },
    };
  }
  async getUserStats() {
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_KEY as string,
    );

    const { data, error } = await supabaseAdmin.rpc('get_user_statistics');

    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi lấy thống kê: ${error.message}`,
      );
    }

    // Trả về mặc định là 0 nếu chưa có data
    if (!data || data.length === 0) {
      return { totalUsers: 0, newThisMonth: 0, totalAdmins: 0 };
    }

    const stats = data[0];

    return {
      totalUsers: Number(stats.total_users),
      newThisMonth: Number(stats.new_this_month),
      totalAdmins: Number(stats.total_admins),
    };
  }

  async getAdminProfile(userId: string) {
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_KEY as string,
    );

    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, full_name, email, phone_number, date_of_birth, avatar_url')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        `Failed to load admin profile: ${error.message}`,
      );
    }

    if (!data) {
      throw new NotFoundException('Admin profile not found');
    }

    return {
      id: data.id,
      fullName: data.full_name,
      email: data.email,
      phone: data.phone_number,
      phoneNumber: data.phone_number,
      dateOfBirth: data.date_of_birth,
      avatarUrl: data.avatar_url,
    };
  }

  async updateAdminProfile(userId: string, updateDto: any) {
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_KEY as string,
    );

    // Lấy avatar cũ trước khi update để xóa sau nếu có thay đổi
    const { data: currentUser } = await supabaseAdmin
      .from('users')
      .select('avatar_url')
      .eq('id', userId)
      .single();

    const { data, error } = await supabaseAdmin
      .from('users')
      .update({
        full_name: updateDto.fullName,
        phone_number: updateDto.phone,
        date_of_birth: updateDto.dateOfBirth || null,
        avatar_url: updateDto.avatarUrl,
      })
      .eq('id', userId)
      .select();

    if (error) {
      throw new InternalServerErrorException(
        `Lỗi khi cập nhật DB: ${error.message}`,
      );
    }

    // Xóa avatar cũ khỏi storage sau khi DB update thành công (non-blocking)
    if (
      currentUser?.avatar_url &&
      updateDto.avatarUrl &&
      currentUser.avatar_url !== updateDto.avatarUrl
    ) {
      void this.uploadService.deleteFromR2(currentUser.avatar_url);
    }

    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
      userId,
      {
        user_metadata: {
          full_name: updateDto.fullName,
          phone_number: updateDto.phone,
          date_of_birth: updateDto.dateOfBirth || null,
          avatar_url: updateDto.avatarUrl,
        },
      },
    );

    if (authError) {
      throw new InternalServerErrorException(
        `Lỗi khi cập nhật Auth Metadata: ${authError.message}`,
      );
    }

    return { success: true, user: data[0] };
  }
}
