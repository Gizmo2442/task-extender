export function debugLog(message: string, data?: any, debugEnabled: boolean = true) {
    if (debugEnabled) {
        if (data) {
            console.log(`[Timeline Debug] ${message}`, data);
        } else {
            console.log(`[Timeline Debug] ${message}`);
        }
    }
}

export function formatTimeEstimate(estimate: { days: number, hours: number, minutes: number }): string {
    const parts = [];
    if (estimate.days > 0) parts.push(`${estimate.days}d`);
    if (estimate.hours > 0) parts.push(`${estimate.hours}h`);
    if (estimate.minutes > 0) parts.push(`${estimate.minutes}m`);
    return parts.join(' ');
}

export function generateTaskId(): string {
    return 'task_' + Math.random().toString(36).substr(2, 9);
}

export function getTaskKey(taskText: string): string {
    // Get the task content after the checkbox
    const match = taskText.match(/^- \[[ x]\] (.*)/);
    return match ? match[1] : taskText;
}

export function zoom(
    hourHeight: number,
    factor: number,
    mouseY: number | undefined,
    timelineEl: HTMLElement,
    timeBlocks: Map<string, any>,
    minHourHeight: number,
    maxHourHeight: number
): number {
    const newHeight = Math.min(Math.max(hourHeight * factor, minHourHeight), maxHourHeight);
    if (newHeight !== hourHeight) {
        // If mouseY is provided, maintain the same timeline position under cursor
        if (mouseY !== undefined) {
            const container = timelineEl;
            const scrollBefore = container.scrollTop;
            const hourUnderMouse = (scrollBefore + mouseY) / hourHeight;
            
            hourHeight = newHeight;
            
            // Update all elements
            timelineEl.querySelectorAll('.time-slot').forEach((slot: HTMLElement) => {
                slot.style.height = `${hourHeight}px`;
            });
            timeBlocks.forEach(block => {
                const blockEl = timelineEl.querySelector(`[data-block-id="${block.id}"]`) as HTMLElement;
                if (blockEl) {
                    blockEl.style.top = `${block.startHour * hourHeight}px`;
                    blockEl.style.height = `${(block.endHour - block.startHour) * hourHeight}px`;
                }
            });

            // Adjust scroll to keep the same hour under mouse
            const newScrollTop = (hourUnderMouse * hourHeight) - mouseY;
            container.scrollTop = newScrollTop;
        } else {
            // Regular zoom without mouse position
            hourHeight = newHeight;
            timelineEl.querySelectorAll('.time-slot').forEach((slot: HTMLElement) => {
                slot.style.height = `${hourHeight}px`;
            });
            timeBlocks.forEach(block => {
                const blockEl = timelineEl.querySelector(`[data-block-id="${block.id}"]`) as HTMLElement;
                if (blockEl) {
                    blockEl.style.top = `${block.startHour * hourHeight}px`;
                    blockEl.style.height = `${(block.endHour - block.startHour) * hourHeight}px`;
                }
            });
        }
    }
    return hourHeight;
} 