import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
@Injectable()
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private logger: Logger = new Logger('NotificationsGateway');

  // Map to store connected users: userId -> socketId[]
  private connectedUsers: Map<string, string[]> = new Map();

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.removeUserSocket(client.id);
  }

  @SubscribeMessage('join')
  handleJoin(@MessageBody() data: { userId: string }, @ConnectedSocket() client: Socket) {
    const { userId } = data;
    if (!userId) return;

    const userSockets = this.connectedUsers.get(userId) || [];
    if (!userSockets.includes(client.id)) {
      userSockets.push(client.id);
      this.connectedUsers.set(userId, userSockets);
      this.logger.log(`User ${userId} joined with socket ${client.id}`);
    }
  }

  private removeUserSocket(socketId: string) {
    for (const [userId, sockets] of this.connectedUsers.entries()) {
      const index = sockets.indexOf(socketId);
      if (index !== -1) {
        sockets.splice(index, 1);
        if (sockets.length === 0) {
          this.connectedUsers.delete(userId);
        } else {
          this.connectedUsers.set(userId, sockets);
        }
        break;
      }
    }
  }

  sendNotificationToUser(userId: string, notification: any) {
    const userSockets = this.connectedUsers.get(userId);
    if (userSockets && userSockets.length > 0) {
      userSockets.forEach((socketId) => {
        this.server.to(socketId).emit('new_notification', notification);
      });
      this.logger.log(`Notification sent to user ${userId}`);
    } else {
      this.logger.warn(
        `User ${userId} has no connected socket — notification was saved but not delivered in real time`,
      );
    }
  }

  sendNotificationToAdmins(adminIds: string[], notification: any) {
    adminIds.forEach((adminId) => {
      this.sendNotificationToUser(adminId, notification);
    });
  }
}
