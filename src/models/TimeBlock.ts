export interface TimeBlock {
    id: string;
    title: string;
    startTime: number;  // Decimal hour (e.g., 9.25 for 9:15)
    endTime: number;    // Decimal hour (e.g., 10.5 for 10:30)
    tasks: Array<string | { id: string | null; text: string | null; timeSlot: number }>;
} 