"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCalendarClient = getCalendarClient;
exports.bookAppointment = bookAppointment;
const googleapis_1 = require("googleapis");
const prisma_1 = require("./prisma");
/**
 * Gets a valid Google Calendar client for a workspace.
 * Automatically refreshes expired tokens.
 */
async function getCalendarClient(workspaceId) {
    const workspace = await prisma_1.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
            googleAccessToken: true,
            googleRefreshToken: true,
            googleTokenExpiry: true,
        },
    });
    if (!workspace?.googleAccessToken) {
        throw new Error("Google Calendar not connected. Please sign in with Google.");
    }
    const oauth2 = new googleapis_1.google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    oauth2.setCredentials({
        access_token: workspace.googleAccessToken,
        refresh_token: workspace.googleRefreshToken,
    });
    // Auto-refresh if expired
    if (workspace.googleTokenExpiry && new Date() > workspace.googleTokenExpiry) {
        const { credentials } = await oauth2.refreshAccessToken();
        await prisma_1.prisma.workspace.update({
            where: { id: workspaceId },
            data: {
                googleAccessToken: credentials.access_token,
                googleTokenExpiry: new Date(credentials.expiry_date),
            },
        });
        oauth2.setCredentials(credentials);
    }
    return googleapis_1.google.calendar({ version: "v3", auth: oauth2 });
}
/**
 * Books an appointment on the workspace owner's Google Calendar.
 * Called by the AI agent during a call.
 */
async function bookAppointment(params) {
    const calendar = await getCalendarClient(params.workspaceId);
    const event = await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
            summary: params.summary,
            description: `Booked by AI agent\nCaller: ${params.callerName}\nPhone: ${params.callerPhone}\n${params.notes ?? ""}`,
            start: { dateTime: params.startTime, timeZone: "Asia/Kolkata" },
            end: { dateTime: params.endTime, timeZone: "Asia/Kolkata" },
        },
    });
    return event.data;
}
