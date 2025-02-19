export interface TaskMetadata {
    originalDate?: Date;
    timeEstimate?: {
        days: number;
        hours: number;
        minutes: number;
        totalMinutes: number;
    };
    dueDate?: Date;
    completed?: boolean;
}

export class TaskParser {
    static parseTimeEstimate(text: string): TaskMetadata['timeEstimate'] | null {
        // Match patterns like "⏱️ 1d 2h 3m" or "⏱️ 2h 30m" or "⏱️ 45m"
        const regex = /⏱️\s*(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?/;
        const match = text.match(regex);
        
        if (!match) return null;
        
        const days = parseInt(match[1] || '0');
        const hours = parseInt(match[2] || '0');
        const minutes = parseInt(match[3] || '0');
        
        const totalMinutes = (days * 24 * 60) + (hours * 60) + minutes;
        
        return {
            days,
            hours,
            minutes,
            totalMinutes
        };
    }

    static parseOriginalDate(text: string, originalDateEmoji: string): Date | null {
        const regex = new RegExp(`${originalDateEmoji}\\s*(\\d{4}-\\d{2}-\\d{2})`);
        const match = text.match(regex);
        
        if (!match) return null;
        
        return new Date(match[1]);
    }

    static parseDueDate(text: string): Date | null {
        // Match the Tasks plugin due date format (📅 YYYY-MM-DD)
        const regex = /📅\s*(\d{4}-\d{2}-\d{2})/;
        const match = text.match(regex);
        
        if (!match) return null;
        
        return new Date(match[1]);
    }

    static parseTask(taskText: string, settings: { originalDateEmoji: string }): TaskMetadata {
        const metadata: TaskMetadata = {};
        
        // Parse original date
        const originalDate = this.parseOriginalDate(taskText, settings.originalDateEmoji);
        if (originalDate !== null) {
            metadata.originalDate = originalDate;
        }
        
        // Parse time estimate
        const timeEstimate = this.parseTimeEstimate(taskText);
        if (timeEstimate !== null) {
            metadata.timeEstimate = timeEstimate;
        }

        // Parse due date
        const dueDate = this.parseDueDate(taskText);
        if (dueDate !== null) {
            metadata.dueDate = dueDate;
        }
        
        // Parse completion status
        metadata.completed = taskText.includes('- [x]');
        
        return metadata;
    }
} 