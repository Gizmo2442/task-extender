export interface TimeBlock {
    id: string;
    title: string;
    startHour: number;
    endHour: number;
    tasks: string[];  // Array of task keys
} 