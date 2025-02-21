import { App, TFile } from 'obsidian';
import type { ITimelineView } from './TimelineInterfaces';
import type { TaskIdentity } from './TaskManager';

interface TaskInfo {
    id: string | null;
    text: string | null;
    timeSlot: number;
}

export interface TimeBlock {
    id: string;
    title: string;
    startTime: number;  // Decimal hour (e.g., 9.25 for 9:15)
    endTime: number;    // Decimal hour (e.g., 10.5 for 10:30)
    tasks: (string | TaskInfo)[];
}

export class TimeBlockManager {
    private timeBlocks: Map<string, TimeBlock> = new Map();
    private debugEnabled: boolean = true;

    constructor(
        private app: App,
        private view: ITimelineView,
        private hourHeight: number
    ) {}

    async loadTimeBlocks(currentDayFile: TFile | null) {
        if (!currentDayFile) return;
        
        const content = await this.app.vault.read(currentDayFile);
        const match = content.match(/```timeBlocks\n([\s\S]*?)\n```/);
        
        if (match) {
            try {
                const timeBlocksData = JSON.parse(match[1]);
                
                // Process each block and its tasks
                for (const [blockId, blockData] of Object.entries(timeBlocksData)) {
                    const block = blockData as TimeBlock;
                    const processedTasks: string[] = [];
                    
                    // Process each task in the block
                    for (const taskInfo of block.tasks) {
                        const { id, text } = (typeof taskInfo === 'string' 
                            ? { id: null, text: taskInfo } 
                            : taskInfo) as TaskInfo;
                        
                        // Try to find the task in files
                        const files = this.app.vault.getMarkdownFiles();
                        let found = false;
                        
                        for (const file of files) {
                            const fileContent = await this.app.vault.read(file);
                            const lines = fileContent.split('\n');
                            const taskLine = lines.find(line => 
                                (id && line.includes(`🆔 ${id}`)) || 
                                (text && this.view.getTaskManager().getTaskIdentity(line).identifier === text)
                            );
                            
                            if (taskLine) {
                                const taskIdentity = this.view.getTaskManager().getTaskIdentity(taskLine);
                                taskIdentity.filePath = file.path;
                                this.view.getTaskManager().getTaskCache().set(taskIdentity.identifier, taskIdentity);
                                processedTasks.push(taskIdentity.identifier);
                                found = true;
                                break;
                            }
                        }
                        
                        if (!found) {
                            console.warn('Could not find task:', id || text);
                        }
                    }
                    
                    // Create the block with found tasks
                    this.timeBlocks.set(blockId, {
                        ...block,
                        tasks: processedTasks
                    });
                }
                
                // Render all blocks
                this.timeBlocks.forEach(block => {
                    this.renderTimeBlock(block, this.view.getTimelineEl());
                });
            } catch (e) {
                console.error('Failed to parse time blocks:', e);
            }
        }
    }

    async saveTimeBlocks(currentDayFile: TFile | null) {
        if (!currentDayFile) return;

        const content = await this.app.vault.read(currentDayFile);
        
        // Convert timeBlocks to a format that includes both ID and text for each task
        const timeBlocksData = Object.fromEntries(
            Array.from(this.timeBlocks.entries()).map(([blockId, block]) => {
                const tasksWithInfo = block.tasks.map(task => {
                    const taskId = this.getTaskIdentifier(task);
                    const taskIdentity = this.view.getTaskManager().getTaskCache().get(taskId);
                    if (taskIdentity) {
                        return {
                            id: taskIdentity.identifier,
                            text: taskIdentity.originalContent.replace(/^- \[[ x]\] /, '').trim(),
                            timeSlot: block.startTime
                        };
                    }
                    this.debugLog('Warning: Task not found in cache during save:', taskId);
                    return { id: taskId, text: null, timeSlot: block.startTime };
                });

                return [blockId, {
                    ...block,
                    tasks: tasksWithInfo
                }];
            })
        );

        const timeBlocksJson = JSON.stringify(timeBlocksData, null, 2);

        if (content.includes('```timeBlocks')) {
            const newContent = content.replace(
                /```timeBlocks\n[\s\S]*?\n```/,
                '```timeBlocks\n' + timeBlocksJson + '\n```'
            );
            await this.app.vault.modify(currentDayFile, newContent);
        } else {
            await this.app.vault.modify(
                currentDayFile,
                content + '\n\n```timeBlocks\n' + timeBlocksJson + '\n```'
            );
        }
    }

    renderTimeBlock(block: TimeBlock, parent: DocumentFragment | HTMLElement) {
        // Remove existing block if it exists
        const existingBlock = parent.querySelector(`[data-block-id="${block.id}"]`);
        if (existingBlock) {
            existingBlock.remove();
        }

        const blockEl = document.createElement('div');
        blockEl.addClass('time-block');
        blockEl.setAttribute('data-block-id', block.id);
        
        const top = block.startTime * this.hourHeight;
        const height = (block.endTime - block.startTime) * this.hourHeight;
        
        blockEl.style.top = `${top}px`;
        blockEl.style.height = `${height}px`;
        
        // Calculate and display percentage
        const { percentage, totalMinutes } = this.calculateBlockPercentage(block);
        const titleContainer = blockEl.createEl('div', { cls: 'time-block-header' });
        
        const titleEl = titleContainer.createEl('div', { 
            cls: 'time-block-title',
            text: block.title
        });

        const percentageEl = titleContainer.createEl('div', {
            cls: 'time-block-percentage',
            text: `${Math.round(percentage)}%`
        });
        
        percentageEl.style.color = this.getPercentageColor(percentage);
        if (percentage > 100) {
            percentageEl.style.fontWeight = 'bold';
        }

        // Add resize handles
        const topHandle = blockEl.createEl('div', { cls: 'time-block-handle top-handle' });
        const bottomHandle = blockEl.createEl('div', { cls: 'time-block-handle bottom-handle' });

        // Setup drag handlers for the block
        this.setupBlockDragHandlers(blockEl, block.id);
        
        // Setup resize handlers
        this.setupBlockResizeHandlers(blockEl, block.id, topHandle, bottomHandle);

        this.setupBlockDropZone(blockEl, block.id);

        block.tasks.forEach(task => {
            this.renderTaskInBlock(this.getTaskIdentifier(task), blockEl);
        });

        parent.appendChild(blockEl);
    }

    public updateHourHeight(newHeight: number) {
        this.hourHeight = newHeight;
        // Re-render all blocks with new height
        this.timeBlocks.forEach(block => {
            this.renderTimeBlock(block, this.view.getTimelineEl());
        });
    }

    private calculateBlockPercentage(block: TimeBlock): { percentage: number, totalMinutes: number } {
        let totalTaskMinutes = 0;
        const blockDurationMinutes = (block.endTime - block.startTime) * 60;

        block.tasks.forEach(task => {
            const taskId = this.getTaskIdentifier(task);
            const taskIdentity = this.view.getTaskManager().getTaskCache().get(taskId);
            if (taskIdentity?.metadata.timeEstimate) {
                totalTaskMinutes += taskIdentity.metadata.timeEstimate.totalMinutes;
            }
        });

        return {
            percentage: (totalTaskMinutes / blockDurationMinutes) * 100,
            totalMinutes: totalTaskMinutes
        };
    }

    private getPercentageColor(percentage: number): string {
        if (percentage <= 50) return 'var(--color-green)';
        if (percentage <= 75) return 'var(--color-yellow)';
        if (percentage <= 90) return 'var(--color-orange)';
        return 'var(--color-red)';
    }

    private async renderTaskInBlock(taskKey: string, container: HTMLElement) {
        // First get the latest task content from cache
        const taskIdentity = this.view.getTaskManager().getTaskCache().get(taskKey);
        if (!taskIdentity) {
            // Try to find task by ID in files if not in cache
            const files = this.app.vault.getMarkdownFiles();
            for (const file of files) {
                const content = await this.app.vault.read(file);
                const lines = content.split('\n');
                const taskLine = lines.find(line => 
                    line.includes(`🆔 ${taskKey}`) || 
                    this.view.getTaskManager().getTaskIdentity(line).identifier === taskKey
                );
                if (taskLine) {
                    const newIdentity = this.view.getTaskManager().getTaskIdentity(taskLine);
                    newIdentity.filePath = file.path;
                    this.view.getTaskManager().getTaskCache().set(taskKey, newIdentity);
                    const taskEl = await this.view.getTaskManager().createTaskElement(taskLine, newIdentity);
                    if (taskEl) {
                        container.appendChild(taskEl);
                    }
                    return;
                }
            }
            console.warn('Task not found in cache or files:', taskKey);
            return;
        }

        // Create a new task element with the latest content
        const taskEl = await this.view.getTaskManager().createTaskElement(taskIdentity.originalContent, taskIdentity);
        if (taskEl) {
            container.appendChild(taskEl);
        }
    }

    private setupBlockDragHandlers(blockEl: HTMLElement, blockId: string) {
        let isDragging = false;
        let startY = 0;
        let startTop = 0;
        let originalBlock: TimeBlock;

        blockEl.addEventListener('mousedown', (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target === blockEl || 
                (target.parentElement === blockEl && !target.classList.contains('time-block-handle') && 
                !target.classList.contains('time-block-title') && 
                !target.classList.contains('timeline-task'))) {
                isDragging = true;
                startY = e.clientY;
                startTop = blockEl.offsetTop;
                originalBlock = {...this.timeBlocks.get(blockId)!};
                blockEl.addClass('dragging');
                e.preventDefault();
            }
        });

        document.addEventListener('mousemove', (e: MouseEvent) => {
            if (!isDragging) return;

            const deltaY = e.clientY - startY;
            const newTop = startTop + deltaY;
            
            // Convert pixel position to decimal hours
            const newStartTime = Math.round((newTop / this.hourHeight) * 4) / 4;
            const duration = originalBlock.endTime - originalBlock.startTime;
            
            // Ensure block stays within timeline bounds
            if (newStartTime >= 0 && newStartTime + duration <= 24) {
                blockEl.style.top = `${newStartTime * this.hourHeight}px`;
                
                // Update block times
                const block = this.timeBlocks.get(blockId)!;
                block.startTime = newStartTime;
                block.endTime = newStartTime + duration;
            }
        });

        document.addEventListener('mouseup', async () => {
            if (isDragging) {
                isDragging = false;
                blockEl.removeClass('dragging');
                await this.saveTimeBlocks(this.view.getCurrentDayFile());
            }
        });
    }

    private setupBlockResizeHandlers(
        blockEl: HTMLElement, 
        blockId: string, 
        topHandle: HTMLElement, 
        bottomHandle: HTMLElement
    ) {
        let isResizing = false;
        let resizeType: 'top' | 'bottom' = 'top';
        let startY = 0;
        let startTop = 0;
        let startHeight = 0;
        let originalBlock: TimeBlock;

        const startResize = (e: MouseEvent, type: 'top' | 'bottom') => {
            isResizing = true;
            resizeType = type;
            startY = e.clientY;
            startTop = blockEl.offsetTop;
            startHeight = blockEl.offsetHeight;
            originalBlock = {...this.timeBlocks.get(blockId)!};
            blockEl.addClass('resizing');
            e.preventDefault();
            e.stopPropagation();
        };

        topHandle.addEventListener('mousedown', (e) => startResize(e, 'top'));
        bottomHandle.addEventListener('mousedown', (e) => startResize(e, 'bottom'));

        document.addEventListener('mousemove', (e: MouseEvent) => {
            if (!isResizing) return;

            const deltaY = e.clientY - startY;
            const block = this.timeBlocks.get(blockId)!;

            if (resizeType === 'top') {
                const newTop = startTop + deltaY;
                const newStartTime = Math.round((newTop / this.hourHeight) * 4) / 4;
                
                if (newStartTime >= 0 && newStartTime < block.endTime) {
                    blockEl.style.top = `${newStartTime * this.hourHeight}px`;
                    blockEl.style.height = `${(block.endTime - newStartTime) * this.hourHeight}px`;
                    block.startTime = newStartTime;
                }
            } else {
                const newHeight = startHeight + deltaY;
                const newEndTime = Math.round(((startTop + newHeight) / this.hourHeight) * 4) / 4;
                
                if (newEndTime <= 24 && newEndTime > block.startTime) {
                    blockEl.style.height = `${(newEndTime - block.startTime) * this.hourHeight}px`;
                    block.endTime = newEndTime;
                }
            }
        });

        document.addEventListener('mouseup', async () => {
            if (isResizing) {
                isResizing = false;
                blockEl.removeClass('resizing');
                await this.saveTimeBlocks(this.view.getCurrentDayFile());
            }
        });
    }

    private setupBlockDropZone(element: HTMLElement, blockId: string) {
        element.addEventListener('dragover', (e) => {
            e.preventDefault();
            element.addClass('drag-over');
        });

        element.addEventListener('dragleave', () => {
            element.removeClass('drag-over');
        });

        element.addEventListener('drop', async (e) => {
            e.preventDefault();
            element.removeClass('drag-over');
            const rawIdentifier = e.dataTransfer?.getData('text/plain');
            if (!rawIdentifier) return;
            
            await this.view.getTaskDragManager().handleTaskDrop(
                rawIdentifier,
                element,
                this.timeBlocks,
                blockId
            );
        });
    }

    getTimeBlocks() {
        return this.timeBlocks;
    }

    private debugLog(message: string, data?: any) {
        if (this.debugEnabled) {
            if (data) {
                console.log(`[Timeline Debug] ${message}`, data);
            } else {
                console.log(`[Timeline Debug] ${message}`);
            }
        }
    }

    private getTaskIdentifier(task: string | TaskInfo): string {
        return typeof task === 'string' ? task : (task.id || task.text || '');
    }
}