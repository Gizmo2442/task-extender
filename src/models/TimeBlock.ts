export interface TimeBlock {
    id: string;
    title: string;
    startHour: number;
    endHour: number;
    tasks: Array<string | { id: string | null; text: string | null; timeSlot: number }>;
} 