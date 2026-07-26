import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class PushNotificationService implements OnModuleInit {
  private readonly logger = new Logger(PushNotificationService.name);
  private initialized = false;

  onModuleInit() {
    const candidates = [
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
      path.resolve(process.cwd(), 'firebase-service-account.json'),
      path.resolve(
        process.cwd(),
        'api-service',
        'firebase-service-account.json',
      ),
      path.resolve(__dirname, '../../../../firebase-service-account.json'),
    ].filter((value): value is string => !!value);
    const serviceAccountPath = candidates.find((value) => fs.existsSync(value));

    if (!serviceAccountPath) {
      this.logger.warn(
        `firebase-service-account.json not found — FCM push disabled (checked: ${candidates.join(', ')})`,
      );
      return;
    }

    try {
      if (!admin.apps.length) {
        const serviceAccount = JSON.parse(
          fs.readFileSync(serviceAccountPath, 'utf8'),
        );
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
      }
      this.initialized = true;
      this.logger.log(
        `Firebase Admin initialized — FCM push enabled (${serviceAccountPath})`,
      );
    } catch (err) {
      this.logger.error('Failed to initialize Firebase Admin:', err);
    }
  }

  async sendPush(
    fcmToken: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    if (!this.initialized) {
      this.logger.warn('FCM push skipped because Firebase Admin is disabled');
      return;
    }
    if (!fcmToken) {
      this.logger.warn('FCM push skipped because the user has no FCM token');
      return;
    }

    try {
      await admin.messaging().send({
        token: fcmToken,
        notification: { title, body },
        data: data ?? {},
        android: {
          priority: 'high',
          notification: { sound: 'default', channelId: 'default' },
        },
      });
    } catch (err) {
      // Token expired/unregistered — log but don't throw (not critical)
      this.logger.warn(
        `FCM send failed for token ${fcmToken.slice(0, 20)}...: ${err?.message}`,
      );
    }
  }
}
