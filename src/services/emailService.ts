import nodemailer from "nodemailer";
import sgMail from "@sendgrid/mail";
import { env } from "../config/env";

export type EmailAttachment = {
  filename: string;
  content: Buffer | string;
  contentType?: string;
};

export type EmailOptions = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
};

class EmailService {
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    if (env.EMAIL_PROVIDER === "smtp" && env.SMTP_HOST) {
      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT || 587,
        secure: (env.SMTP_PORT || 587) === 465,
        auth: env.SMTP_USER
          ? {
              user: env.SMTP_USER,
              pass: env.SMTP_PASS || "",
            }
          : undefined,
      });
    } else if (env.EMAIL_PROVIDER === "sendgrid" && env.SENDGRID_API_KEY) {
      sgMail.setApiKey(env.SENDGRID_API_KEY);
    }
  }

  async sendEmail(options: EmailOptions): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    try {
      const from = `${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM}>`;

      if (env.EMAIL_PROVIDER === "sendgrid" && env.SENDGRID_API_KEY) {
        const msg: any = {
          to: options.to,
          from: env.EMAIL_FROM,
          subject: options.subject,
          text: options.text || "",
          html: options.html || "",
        };
        
        if (options.attachments && options.attachments.length > 0) {
          msg.attachments = options.attachments.map((att) => ({
            filename: att.filename,
            content: att.content,
            type: att.contentType,
          }));
        }

        const [response] = await sgMail.send(msg);
        return { ok: true, messageId: response.headers["x-message-id"] as string };
      } else if (env.EMAIL_PROVIDER === "smtp" && this.transporter) {
        const info = await this.transporter.sendMail({
          from,
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html,
          attachments: options.attachments,
        });

        return { ok: true, messageId: info.messageId };
      } else {
        // Console provider - for development
        console.log("\n📧 EMAIL WOULD BE SENT:");
        console.log("=" .repeat(60));
        console.log(`From: ${from}`);
        console.log(`To: ${options.to}`);
        console.log(`Subject: ${options.subject}`);
        console.log(`Text: ${options.text?.substring(0, 200)}...`);
        console.log(`HTML: ${options.html?.substring(0, 200)}...`);
        console.log("=" .repeat(60) + "\n");
        
        return { ok: true, messageId: "console-provider" };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown email error";
      console.error("[EmailService] Failed to send email:", message);
      return { ok: false, error: message };
    }
  }

  // Template for sending documents to customers using SendGrid Dynamic Template
  async sendDocumentsEmail(data: {
    to: string;
    customerName: string | undefined;
    shopName: string | undefined;
    documents: Array<{
      name: string;
      uniqueLink: string;
      validTo: string | undefined;
    }>;
  }): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    // For SendGrid, use Dynamic Template
    if (env.EMAIL_PROVIDER === "sendgrid" && env.SENDGRID_API_KEY) {
      const templateId = "d-bcf34c2bbf7948c5824cf8694eb6301b"; // Your template ID
      
      // Prepare template data - handle multiple documents
      const documentLinks = data.documents.map(doc => ({
        email: data.to,
        uniqueLink: doc.uniqueLink,
        landingUrl: `https://api.idoxxy.com/documents/access/${doc.uniqueLink}`,
        documentName: doc.name,
        validTo: doc.validTo
      }));

      // Send one email per document (template expects single document)
      // Or modify to send single email with all documents
      const results = [];
      
      for (const doc of documentLinks) {
        const msg: any = {
          to: data.to,
          from: env.EMAIL_FROM,
          templateId: templateId,
          dynamicTemplateData: {
            email: doc.email,
            uniqueLink: doc.uniqueLink,
            landingUrl: doc.landingUrl,
            documentName: doc.documentName,
            customerName: data.customerName,
            shopName: data.shopName
          }
        };

        try {
          const [response] = await sgMail.send(msg);
          results.push({ ok: true, messageId: response.headers["x-message-id"] });
        } catch (error) {
          const message = error instanceof Error ? error.message : "SendGrid error";
          results.push({ ok: false, error: message });
        }
      }

      // Return first successful or last error
      const success = results.find(r => r.ok);
      if (success) {
        return { ok: true, messageId: success.messageId };
      }
      return { ok: false, error: results[results.length - 1]?.error || "Unknown error" };
    }

    // Fallback to HTML email for SMTP/Console
    const subject = `Dokumenty trwałego nośnika - ${data.shopName || "Twój sklep"}`;
    
    const documentsList = data.documents
      .map(
        (doc) => `
        <li style="margin-bottom: 16px;">
          <strong>${doc.name}</strong><br>
          <a href="https://api.idoxxy.com/documents/access/${doc.uniqueLink}" 
             style="color: #1f4b99; text-decoration: none; font-weight: 600;">
            📄 Otwórz dokument
          </a>
          ${doc.validTo ? `<br><small style="color: #666;">Ważny do: ${new Date(doc.validTo).toLocaleDateString("pl-PL")}</small>` : ""}
        </li>
      `
      )
      .join("");

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${subject}</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #1f4b99;">Dokumenty trwałego nośnika</h2>
            
            <p>Witaj ${data.customerName || ""},</p>
            
            <p>W załączeniu znajdziesz dokumenty przypisane do Twojego konta w sklepie 
               <strong>${data.shopName || "Shoper"}</strong>:</p>
            
            <ul style="padding-left: 20px;">
              ${documentsList}
            </ul>
            
            <div style="background: #f5f7fa; padding: 16px; border-radius: 8px; margin-top: 24px;">
              <p style="margin: 0; font-size: 14px; color: #666;">
                <strong>Ważne:</strong> Dokumenty są dostępne w formie trwałego nośnika 
                zgodnie z wymogami prawnymi. Linki są unikalne i przypisane do Twojego konta.
              </p>
            </div>
            
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
            
            <p style="font-size: 12px; color: #666;">
              Wiadomość wysłana automatycznie przez system Shoper ↔ Idoxxy.<br>
              W przypadku pytań prosimy o kontakt z obsługą sklepu.
            </p>
          </div>
        </body>
      </html>
    `;

    const text = `
Dokumenty trwałego nośnika - ${data.shopName || "Twój sklep"}

Witaj ${data.customerName || ""},

W załączeniu znajdziesz dokumenty przypisane do Twojego konta:

${data.documents.map(doc => `- ${doc.name}: https://api.idoxxy.com/documents/access/${doc.uniqueLink}`).join("\n")}

Dokumenty są dostępne w formie trwałego nośnika zgodnie z wymogami prawnymi.

---
Wiadomość wysłana automatycznie przez system Shoper ↔ Idoxxy.
    `;

    return this.sendEmail({
      to: data.to,
      subject,
      html,
      text,
    });
  }
}

export const emailService = new EmailService();
