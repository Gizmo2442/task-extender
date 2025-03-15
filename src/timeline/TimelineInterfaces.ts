import type { TFile, Component } from 'obsidian';
import type { TaskManager } from './TaskManager';
import type TaskPlannerPlugin from '../main';
import type { TimeBlockManager } from './TimeBlockManager';
import type { TaskDragManager } from './TaskDragManager';
import type { Moment } from 'moment';

export interface ITimelineView extends Component {
    getPlugin(): TaskPlannerPlugin;
    getTimelineEl(): HTMLElement;
    getCurrentDayFile(): TFile | null;
    getCurrentDate(): Moment;
    getTaskManager(): TaskManager;
    getTimeBlockManager(): TimeBlockManager;
    getTaskDragManager(): TaskDragManager;
    refreshView(): Promise<void>;
}