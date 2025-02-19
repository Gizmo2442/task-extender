export interface ScheduledTask {
    taskText: string;
    timeSlot: number | 'unscheduled';
    metadata: {
        originalDate?: Date;
        timeEstimate?: {
            days: number;
            hours: number;
            minutes: number;
            totalMinutes: number;
        };
        dueDate?: Date;
    };
} 