import { Controller, Get, HttpException, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { OrdersService } from './orders.service';

interface OrderEmailActionResult {
  success: boolean;
  message: string;
}

@ApiTags('Order Email Actions')
@Controller('order-actions')
export class OrderActionsController {
  constructor(private readonly service: OrdersService) {}

  @Get(':token')
  @ApiOperation({
    summary: 'Handle order status action from restaurant email link',
  })
  @ApiQuery({
    name: 'action',
    required: true,
    description: 'confirm | cancel',
  })
  async handleAction(
    @Param('token') token: string,
    @Query('action') action: string,
    @Res() res: Response,
  ) {
    try {
      const result = (await this.service.handleOrderEmailAction(
        token,
        action,
      )) as OrderEmailActionResult;

      const html = result.success
        ? this.renderPage({
            icon: '✅',
            title: 'Thao tác thành công',
            message: result.message,
            accentColor: '#16a34a',
          })
        : this.renderPage({
            icon: '⚠️',
            title: 'Không thể thực hiện',
            message: result.message,
            accentColor: '#f59e0b',
          });

      res.status(200).type('html').send(html);
    } catch (error) {
      const status =
        error instanceof HttpException ? error.getStatus() : 500;
      const response =
        error instanceof HttpException ? error.getResponse() : null;
      const message =
        typeof response === 'string'
          ? response
          : Array.isArray((response as { message?: unknown })?.message)
            ? ((response as { message: unknown[] }).message.join(', '))
            : (response as { message?: string })?.message ||
              'Đã xảy ra lỗi không xác định. Vui lòng thử lại sau.';

      res
        .status(status)
        .type('html')
        .send(
          this.renderPage({
            icon: '❌',
            title: 'Có lỗi xảy ra',
            message,
            accentColor: '#ef4444',
          }),
        );
    }
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private renderPage(options: {
    icon: string;
    title: string;
    message: string;
    accentColor: string;
  }): string {
    const { icon, title, message, accentColor } = options;

    return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${this.escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f8fafc;
    font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    padding: 24px;
  }
  .card {
    background: #ffffff;
    border-radius: 20px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.08);
    padding: 40px 32px;
    max-width: 420px;
    width: 100%;
    text-align: center;
    border-top: 4px solid ${accentColor};
  }
  .icon { font-size: 48px; line-height: 1; margin-bottom: 16px; }
  h1 { font-size: 1.25rem; margin: 0 0 12px; color: #1e293b; }
  p { margin: 0; color: #64748b; font-size: 0.95rem; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${this.escapeHtml(title)}</h1>
    <p>${this.escapeHtml(message)}</p>
  </div>
</body>
</html>`;
  }
}
