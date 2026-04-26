import { google } from "googleapis";
import { prisma } from "./prisma";

/**
 * Gets a valid Google Calendar client for a workspace.
 * Automatically refreshes expired tokens.
 */
export async function getCalendarClient(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      googleAccessToken:  true,
      googleRefreshToken: true,
      googleTokenExpiry:  true,
    } as any,
  }) as any;

  if (!workspace?.googleAccessToken) {
    throw new Error("Google Calendar not connected. Please sign in with Google.");
  }

  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );

  oauth2.setCredentials({
    access_token:  workspace.googleAccessToken,
    refresh_token: workspace.googleRefreshToken,
  });

  // Auto-refresh if expired
  if (workspace.googleTokenExpiry && new Date() > workspace.googleTokenExpiry) {
    const { credentials } = await oauth2.refreshAccessToken();
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        googleAccessToken: credentials.access_token,
        googleTokenExpiry: new Date(credentials.expiry_date!),
      } as any,
    });
    oauth2.setCredentials(credentials);
  }

  return google.calendar({ version: "v3", auth: oauth2 });
}

/**
 * Books an appointment on the workspace owner's Google Calendar.
 * Called by the AI agent during a call.
 */
export async function bookAppointment(params: {
  workspaceId: string;
  summary:     string;     // e.g. "Dr. Sharma - Consultation"
  startTime:   string;     // ISO string e.g. "2026-04-25T10:00:00+05:30"
  endTime:     string;     // ISO string e.g. "2026-04-25T10:30:00+05:30"
  callerName:  string;
  callerPhone: string;
  notes?:      string;
}) {
  const calendar = await getCalendarClient(params.workspaceId);

  const event = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary:     params.summary,
      description: `Booked by AI agent\nCaller: ${params.callerName}\nPhone: ${params.callerPhone}\n${params.notes ?? ""}`,
      start: { dateTime: params.startTime, timeZone: "Asia/Kolkata" },
      end:   { dateTime: params.endTime,   timeZone: "Asia/Kolkata" },
    },
  });

  return event.data;
}
