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
import { createLimitedFetch } from 'src/config/supabase-http';

const adminLimitedFetch = createLimitedFetch();

@Injectable()
export class AdminService {
  private supabase: SupabaseClient;

  constructor(private readonly uploadService: UploadService) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase URL or Anon Key');
    }
    this.supabase = createClient(supabaseUrl, supabaseKey, {
      global: { fetch: adminLimitedFetch },
    }) as SupabaseClient;
  }

  private getAdminClient() {
    return createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_KEY as string,
      { global: { fetch: adminLimitedFetch } },
    );
  }

  async createAdmin(createAdminDto: CreateAdminDto) {
    const { email, password, full_name, phone_number, avatar_url } =
      createAdminDto;

    const { data, error } = await this.supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name,
          phone_number,
          avatar_url,
          role: 'ADMIN',
        },
      },
    });

    if (error) {
      throw new BadRequestException(`Dang ky Admin that bai: ${error.message}`);
    }

    return {
      message: 'Tao tai khoan Admin thanh cong.',
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

    const safePage =
      Number.isFinite(Number(page)) && Number(page) > 0 ? Number(page) : 1;
    const safeLimit =
      Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Math.min(Number(limit), 100)
        : 10;
    const offset = (safePage - 1) * safeLimit;

    if (deleteStatus === UserDeleteStatus.DELETED) {
      return {
        data: [],
        meta: {
          totalItems: 0,
          itemCount: 0,
          itemsPerPage: safeLimit,
          totalPages: 0,
          currentPage: safePage,
        },
      };
    }

    let usersQuery = this.getAdminClient()
      .from('users')
      .select(
        'id, role, email, full_name, phone_number, date_of_birth, avatar_url, is_active, created_at',
        { count: 'estimated' },
      );

    if (role) {
      usersQuery = usersQuery.eq('role', role);
    }

    if (activeStatus === UserActiveStatus.ACTIVE) {
      usersQuery = usersQuery.eq('is_active', '1');
    } else if (activeStatus === UserActiveStatus.LOCKED) {
      usersQuery = usersQuery.eq('is_active', '0');
    }

    const keyword = search?.trim().replace(/[(),]/g, ' ');
    if (keyword) {
      usersQuery = usersQuery.or(
        `full_name.ilike.%${keyword}%,email.ilike.%${keyword}%`,
      );
    }

    const { data, error, count } = await usersQuery
      .order('created_at', { ascending: false })
      .range(offset, offset + safeLimit - 1);

    if (error) {
      throw new InternalServerErrorException(
        `Failed to fetch users: ${error.message}`,
      );
    }

    const totalItems = count ?? 0;
    const totalPages = Math.ceil(totalItems / safeLimit);

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
        deleteStatus: UserDeleteStatus.UNDELETED,
        avatarUrl: user.avatar_url,
        joinedDate: user.created_at,
      })),
      meta: {
        totalItems,
        itemCount: data?.length || 0,
        itemsPerPage: safeLimit,
        totalPages,
        currentPage: safePage,
      },
    };
  }

  async getUserDetail(id: string) {
    const { data: user, error } = await this.getAdminClient()
      .from('users')
      .select(
        'id, role, email, full_name, phone_number, date_of_birth, avatar_url, is_active',
      )
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(
        `Failed to fetch user detail: ${error.message}`,
      );
    }

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      phoneNumber: user.phone_number,
      dateOfBirth: user.date_of_birth,
      address: null,
      role: user.role,
      activeStatus:
        user.is_active === '1'
          ? UserActiveStatus.ACTIVE
          : UserActiveStatus.LOCKED,
      deleteStatus: UserDeleteStatus.UNDELETED,
      avatarUrl: user.avatar_url,
    };
  }

  async updateUserStatus(id: string, newStatus: UserActiveStatus) {
    const bitStatus = newStatus === UserActiveStatus.ACTIVE ? '1' : '0';

    const { error } = await this.getAdminClient()
      .from('users')
      .update({ is_active: bitStatus })
      .eq('id', id);

    if (error) {
      throw new InternalServerErrorException(
        `Failed to update user status: ${error.message}`,
      );
    }

    return {
      success: true,
      message: 'Da cap nhat trang thai nguoi dung.',
    };
  }

  async bulkDeleteUsers(userIds: string[]) {
    if (!userIds || userIds.length === 0) {
      throw new BadRequestException('Danh sach ID nguoi dung trong');
    }

    const { data, error } = await this.getAdminClient()
      .from('users')
      .update({ is_active: '0' })
      .in('id', userIds)
      .select('id');

    if (error) {
      throw new InternalServerErrorException(
        `Failed to delete users: ${error.message}`,
      );
    }

    const deletedCount = data?.length ?? 0;
    if (deletedCount === 0) {
      throw new NotFoundException('Khong tim thay nguoi dung hop le de xoa');
    }

    return {
      success: true,
      message: `Da xoa thanh cong ${deletedCount} nguoi dung.`,
      deletedCount,
    };
  }

  async deleteUser(id: string) {
    return this.bulkDeleteUsers([id]);
  }

  async createUserByAdmin(createDto: CreateUserByAdminDto) {
    const { data, error } = await this.getAdminClient().auth.admin.createUser({
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
      throw new BadRequestException(`Khong the tao nguoi dung: ${error.message}`);
    }

    return {
      success: true,
      message: 'Tao tai khoan nguoi dung thanh cong',
      user: {
        id: data.user.id,
        email: data.user.email,
        role: createDto.role,
      },
    };
  }

  async getUserStats() {
    const now = new Date();
    const startOfMonth = new Date(
      now.getFullYear(),
      now.getMonth(),
      1,
    ).toISOString();

    const [totalResult, newMonthResult, adminResult] = await Promise.all([
      this.getAdminClient().from('users').select('id', {
        count: 'estimated',
        head: true,
      }),
      this.getAdminClient()
        .from('users')
        .select('id', { count: 'estimated', head: true })
        .gte('created_at', startOfMonth),
      this.getAdminClient()
        .from('users')
        .select('id', { count: 'estimated', head: true })
        .eq('role', 'ADMIN'),
    ]);

    const error =
      totalResult.error || newMonthResult.error || adminResult.error;
    if (error) {
      throw new InternalServerErrorException(
        `Failed to fetch user stats: ${error.message}`,
      );
    }

    return {
      totalUsers: totalResult.count ?? 0,
      newThisMonth: newMonthResult.count ?? 0,
      totalAdmins: adminResult.count ?? 0,
    };
  }

  async getAdminProfile(userId: string) {
    const { data, error } = await this.getAdminClient()
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
    const supabaseAdmin = this.getAdminClient();

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
        `Failed to update admin profile: ${error.message}`,
      );
    }

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
        `Failed to update auth metadata: ${authError.message}`,
      );
    }

    return { success: true, user: data[0] };
  }
}
